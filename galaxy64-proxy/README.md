# Proxy Galaxy64.dll — interception des succès GOG par hooking

Proxy DLL qui remplace `Galaxy64.dll` du SDK GOG Galaxy pour intercepter les
déblocages de succès et les notifier au GameLauncher en temps réel via Named
Pipe, sans client GOG Galaxy installé.

## Ce qui a changé, et pourquoi

La version précédente reposait sur du **mocking C++** : `Stats()` renvoyait au
jeu un objet `MockStats` maison, qui réimplémentait toute l'interface `IStats`.
Cela oblige à reconstituer la vtable du SDK à la main — et GOG déplace ses
méthodes virtuelles d'une version à l'autre.

Confrontée à un vrai `Galaxy64.dll` **v1.123.0.0**, la reconstitution (faite
d'après les en-têtes **v1.148**) s'est révélée fausse :

| | reconstitution | binaire réel |
|---|---|---|
| `IStats` | 33 slots | **34** |
| `IStats::SetAchievement` | 8 | 8 ✅ |
| `IStats` — premier écart | — | **slot 17** (`IsAchievementVisibleWhileLocked` n'existe pas en 1.123) |
| `IUser` | 23 slots | **25** |
| `IUser::IsLoggedOn` | 15 | **18** ❌ |

Le relevé complet est dans [`docs/vtables_sdk_1.123.md`](docs/vtables_sdk_1.123.md).

**Il n'y a plus de vtable écrite par nous.** `Stats()` et `User()` renvoient le
pointeur réel de `Galaxy64_o.dll`, donc la vraie vtable, celle contre laquelle
`GalaxyCSharpGlue.dll` a été compilé. L'interception se fait à l'intérieur, par
détour MinHook sur le corps de la méthode.

```
Jeu GOG (.exe) ─ ou ─ GalaxyCSharpGlue.dll (Unity/SWIG)
    │
    ├── charge Galaxy64.dll (ce proxy)
    │       │
    │       ├── Stats() ─────► pointeur RÉEL de Galaxy64_o.dll
    │       └── User()  ─────► pointeur RÉEL de Galaxy64_o.dll
    │
    └── Galaxy64_o.dll (DLL originale renommée)
            │
            ├── StatsFacade::SetAchievement            ◄── détour MinHook
            ├── StatsFacade::StoreStatsAndAchievements ◄── détour MinHook
            ├── PeerUserFacade::SignedIn               ◄── détour MinHook
            └── PeerUserFacade::IsLoggedOn             ◄── détour MinHook
```

## Comment les méthodes sont trouvées

Le `Galaxy64.dll` de GOG est compilé **avec ses traces**. Chaque méthode de
façade référence en RIP-relatif une chaîne qui porte son propre nom :

```
"SetAchievement: not signed in with Galaxy"
"SetAchievement: name=%s"
```

Le résolveur (`src/interface_resolver.cpp`) parcourt donc la vtable de l'objet
**réel** et demande, pour chaque slot : *le corps de cette fonction
référence-t-il la chaîne qui nomme `SetAchievement` ?* La réponse vient du
binaire, pas d'une supposition. Les bornes exactes de chaque fonction viennent
de la table `.pdata` du PE ; aucun désassembleur n'est embarqué.

`SignedIn` et `IsLoggedOn` sont de simples accesseurs et n'écrivent aucune
trace. Ils sont situés par **ancrage** sur leurs voisines identifiables :
`IsLoggedOn` se trouve entre `DeleteUserData` et `RequestEncryptedAppTicket`.

Ordre de priorité, du plus fiable au moins fiable :

1. index épinglé à la main dans `galaxy_proxy.ini` ;
2. lecture du binaire (le cas nominal) ;
3. ancrage sur des voisines ;
4. cache d'un lancement précédent ;
5. ordre des en-têtes publics — **signalé bruyamment** dans le journal.

En clair : si le résolveur ne sait pas, il le dit, au lieu d'échouer en
silence.

## Ce que la proxy fait aux succès

Transposition directe de l'ancien `MockStats`, mais exécutée à l'intérieur du
code de GOG :

```cpp
void Hook_SetAchievement(void* self, const char* name) {
    ProxyLog("SetAchievement intercepte: %s", name ? name : "(null)");
    if (name) SendAchievementNotification(name);
    if (g_setAchievementOriginal) g_setAchievementOriginal(self, name);
}
```

`SignedIn()` et `IsLoggedOn()` appellent d'abord l'original — pour ne pas
désynchroniser l'état interne de GOG quand le client tourne vraiment — puis
répondent `true` dans tous les cas. Sans cela rien ne part : la propre
implémentation de GOG commence par
`"SetAchievement: not signed in with Galaxy"` et sort immédiatement.

## Prérequis

- **Windows 10+** (x64)
- **Visual Studio 2019+** avec le toolset MSVC x64
- **CMake 3.15+**
- Accès réseau au premier `cmake ..` : MinHook est récupéré par `FetchContent`

## Compilation

```powershell
cd galaxy64-proxy
mkdir build
cd build
cmake .. -G "Visual Studio 17 2022" -A x64
cmake --build . --config Release
```

Ou simplement `build.bat`, qui cherche VS et CMake tout seul.

### Vérification des exports

```powershell
dumpbin /exports build\Release\Galaxy64.dll
dumpbin /exports Galaxy64_o.dll
```

Tout symbole présent dans l'originale et absent de la proxy empêchera le jeu
de démarrer. Le seul écart connu est `load`, un symbole non décoré qu'aucun
jeu n'importe.

## Déploiement

1. **Renommer** la `Galaxy64.dll` originale du jeu en `Galaxy64_o.dll`
2. **Copier** la proxy `Galaxy64.dll` dans le dossier du jeu

```
MonJeuGOG/
├── game.exe
├── Galaxy64.dll      ← proxy (cette DLL)
├── Galaxy64_o.dll    ← originale renommée
└── galaxy_proxy.ini  ← facultatif (voir galaxy_proxy.ini.example)
```

> **Il n'y a plus de mode standalone.** Sans `Galaxy64_o.dll`, la proxy
> n'implémente plus aucune interface et refuse de fonctionner, en le disant
> dans le journal. C'est le prix assumé de l'indépendance vis-à-vis de la
> disposition des vtables : on ne peut pas à la fois refuser de reconstituer
> une vtable et s'en passer.

## Calibration sur un SDK inconnu

Si le journal signale un repli sur les en-têtes publics, deux façons de lire
la vraie disposition :

**Hors ligne**, sans lancer le jeu :

```
python tools/dump_galaxy_vtables.py "C:\Games\MonJeu\Galaxy64_o.dll"
```

**En jeu**, avec `dump_vtables=1` dans `galaxy_proxy.ini` : la vtable complète
part dans `galaxy_proxy.log`, chaque slot annoté de la chaîne qu'il référence.

Puis épingler l'index trouvé :

```ini
[stats]
set_achievement_index=8
```

## Tests

```
./tests/run_tests.sh /chemin/vers/Galaxy64_o.dll
```

Compile `pattern_scanner.cpp` et `interface_resolver.cpp` **tels quels**, mappe
la DLL fournie à sa base préférée, et fait tourner le résolveur réel dessus.
Vérifie que chaque méthode résolue référence bien la chaîne qui porte son nom —
donc utilisable sur n'importe quelle DLL, pas seulement celle de référence.

Tourne sous Linux/g++ grâce aux doublures de `tests/stubs/`. Le fichier
`Galaxy64_o.dll` n'est pas versionné : prends celui d'un de tes jeux.

## Communication IPC

Inchangée. Notifications JSON via le Named Pipe
`\\.\pipe\GogLauncherAchievements`.

**Déblocage de succès** (`SetAchievement`) :
```json
{"event":"achievement","name":"ACH_FIRST_KILL","timestamp":1693680000}
```

**Sauvegarde des stats** (`StoreStatsAndAchievements`) :
```json
{"event":"store","timestamp":1693680000}
```

Le launcher doit créer le pipe en **serveur** avant le lancement du jeu ;
`test_proxy.py server` en fournit une implémentation de référence sans
dépendance.

## Journal

`galaxy_proxy.log`, à côté de la DLL :

```
[14:32:01] === Proxy Galaxy64 — interception par hooking ===
[14:32:01] Chargement de la DLL originale: C:\Games\MonJeu\Galaxy64_o.dll
[14:32:01] Galaxy64_o.dll chargee (SDK 1.123.0.0)
[14:32:01] Init(clientID=12345678)
[14:32:01] Hook pose sur IStats::SetAchievement : MinHook @ +0x128950 (slot 8, lu dans le binaire)
[14:32:01] Hook pose sur IStats::StoreStatsAndAchievements : MinHook @ +0x1295E0 (slot 10, lu dans le binaire)
[14:32:01] Hook pose sur IUser::SignedIn : MinHook @ +0x1499E0 (slot 1, deduit par ancrage)
[14:32:01] Hook pose sur IUser::IsLoggedOn : MinHook @ +0x149020 (slot 18, deduit par ancrage)
[14:33:10] IUser::SignedIn force a true (le client GOG ne repond pas)
[14:35:22] SetAchievement intercepte: ACH_FIRST_KILL
[14:35:22] IPC: succes notifie -> ACH_FIRST_KILL
[14:35:22] StoreStatsAndAchievements intercepte
```

## Limite connue

Forcer `SignedIn()` à `true` fait franchir au jeu sa première garde, mais
beaucoup de jeux n'appellent `SetAchievement` qu'**après** avoir reçu le
rappel de succès de `RequestUserStatsAndAchievements`. Sans client GOG, cette
opération n'aboutit jamais et le rappel ne part pas : le jeu reste muet, sans
qu'aucun hook soit en cause.

Couvrir ce cas demande d'intercepter aussi `IListenerRegistrar` pour fabriquer
le rappel de succès. Ce n'est pas fait ici.

## Structure des sources

```
galaxy64-proxy/
├── CMakeLists.txt              Build CMake (MinHook via FetchContent)
├── Galaxy64.def                Exports (noms décorés MSVC x64)
├── build.bat                   Build en une commande
├── galaxy_proxy.ini.example    Configuration facultative commentée
├── test_proxy.py               Test bout en bout du pipe (Windows)
├── docs/
│   └── vtables_sdk_1.123.md    Relevé des vtables réelles
├── tools/
│   └── dump_galaxy_vtables.py  Cartographie hors ligne d'un Galaxy64.dll
├── tests/
│   ├── run_tests.sh            Syntaxe + résolution sur une vraie DLL
│   ├── test_resolver.cpp
│   └── stubs/                  Doublures Windows/MinHook pour g++
└── src/
    ├── dllmain.cpp             Exports, transmission pure
    ├── galaxy_types.h          GalaxyID, InitOptions, interfaces opaques
    ├── galaxy_proxy.h/.cpp     Chargement paresseux, symboles, journal
    ├── config.h/.cpp           galaxy_proxy.ini
    ├── pattern_scanner.h/.cpp  Lecture du PE chargé : .pdata, chaînes, refs
    ├── interface_resolver.h/.cpp  Identification des méthodes
    ├── vtable_hook.h/.cpp      MinHook + patch de vtable (repli)
    ├── hooks.h                 Interface de pose
    ├── hooks_common.cpp        Orchestration, réessais
    ├── hooks_stats.cpp         SetAchievement, StoreStatsAndAchievements
    ├── hooks_user.cpp          SignedIn, IsLoggedOn
    └── ipc_client.h/.cpp       Named Pipe, JSON non bloquant
```
