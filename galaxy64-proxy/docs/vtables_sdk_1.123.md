# Vtables réelles du SDK GOG Galaxy 1.123.0.0

Relevé obtenu en lisant le binaire, pas en recopiant un en-tête : les vtables
sont retrouvées par RTTI, puis chaque slot est nommé d'après la chaîne de
journal que sa fonction référence en RIP-relatif
(`"SetAchievement: not signed in with Galaxy"`, etc.).

Reproductible avec :

```
python tools/dump_galaxy_vtables.py Galaxy64_o.dll
```

Binaire de référence : `Galaxy64.dll`, `FileVersion 1.123.0.0`,
`OriginalFilename Galaxy.dll`, base d'image `0x180000000`, 26 exports.

---

## Pourquoi ce document existe

L'ancien `galaxy_types.h` reconstituait ces vtables à la main d'après les
en-têtes publics **v1.148**. Confrontée au binaire v1.123, cette
reconstitution diverge — et c'est exactement le type de panne silencieuse que
le passage au hooking élimine.

| | reconstitution v1.148 | binaire v1.123 |
|---|---|---|
| `IStats` — nombre de slots | 33 | **34** |
| `IStats::SetAchievement` | 8 | 8 ✅ |
| `IStats::StoreStatsAndAchievements` | 10 | 10 ✅ |
| `IStats` — premier écart | — | **slot 17** |
| `IUser` — nombre de slots | 23 | **25** |
| `IUser::SignedIn` | 1 | 1 ✅ |
| `IUser::IsLoggedOn` | 15 | **18** ❌ |
| `IUser` — premier écart | — | **slot 3** |

Les deux méthodes de succès tombent juste. Ce sont les leaderboards
(`IStats`) et tout `IUser` au-delà du slot 2 qui étaient faux.

---

## `IStats` → `galaxy::peer::facade::StatsFacade`

vtable RVA `0x84ef48`, 34 slots.

| slot | méthode | RVA du corps |
|---:|---|---|
| 0 | *destructeur scalaire deleting* | `0x1246d0` |
| 1 | `RequestUserStatsAndAchievements` | `0x128020` |
| 2 | `GetStatInt` | `0x126bd0` |
| 3 | `GetStatFloat` | `0x126970` |
| 4 | `SetStatInt` | `0x129410` |
| 5 | `SetStatFloat` | `0x129230` |
| 6 | `UpdateAvgRateStat` | `0x129ed0` |
| 7 | `GetAchievement` | `0x124fc0` |
| **8** | **`SetAchievement`** | `0x128950` |
| 9 | `ClearAchievement` | `0x1247b0` |
| **10** | **`StoreStatsAndAchievements`** | `0x1295e0` |
| 11 | `ResetStatsAndAchievements` | `0x128680` |
| 12 | `GetAchievementDisplayName` | `0x125540` |
| 13 | `GetAchievementDisplayNameCopy` | `0x1256e0` |
| 14 | `GetAchievementDescription` | `0x125200` |
| 15 | `GetAchievementDescriptionCopy` | `0x1253a0` |
| 16 | `IsAchievementVisible` | `0x127050` |
| 17 | `RequestLeaderboards` | `0x127dd0` |
| 18 | `GetLeaderboardDisplayName` | `0x125880` |
| 19 | `GetLeaderboardDisplayNameCopy` | `0x125a10` |
| 20 | `GetLeaderboardSortMethod` | `0x126040` |
| 21 | `GetLeaderboardDisplayType` | `0x125ba0` |
| 22 | `RequestLeaderboardEntriesGlobal` | `0x127a60` |
| 23 | `RequestLeaderboardEntriesAroundUser` | `0x1271f0` |
| 24 | `RequestLeaderboardEntriesForUsers` | `0x127630` |
| 25 | `GetRequestedLeaderboardEntry` | `0x126520` |
| 26 | `GetRequestedLeaderboardEntryWithDetails` | `0x1266a0` |
| 27 | `SetLeaderboardScore` | `0x128ba0` |
| 28 | `SetLeaderboardScoreWithDetails` | `0x128eb0` |
| 29 | `GetLeaderboardEntryCount` | `0x125d60` |
| 30 | `FindLeaderboard` | `0x1249e0` |
| 31 | `FindOrCreateLeaderboard` | `0x124c50` |
| 32 | `RequestUserTimePlayed` | `0x128350` |
| 33 | `GetUserTimePlayed` | `0x126e20` |

Écarts avec la reconstitution v1.148 :

- `IsAchievementVisibleWhileLocked` **n'existe pas** en 1.123. Tout ce qui
  suit le slot 16 est donc décalé d'un cran.
- `FindLeaderboard` et `FindOrCreateLeaderboard` (slots 30 et 31) **manquaient**
  à la reconstitution.
- L'ordre des méthodes de leaderboard diffère : le binaire place les
  `RequestLeaderboardEntries*` avant les `SetLeaderboardScore*`, la
  reconstitution faisait l'inverse.

Conséquence concrète pour l'ancien mock : un jeu appelant
`SetLeaderboardScore` (slot 27 réel) atterrissait sur
`RequestLeaderboardEntriesAroundUser` du mock.

---

## `IUser` → `galaxy::peer::facade::PeerUserFacade`

vtable RVA `0x8458a8`, 25 slots.

| slot | méthode | RVA du corps |
|---:|---|---|
| 0 | *destructeur scalaire deleting* | `0xfe8b0` |
| **1** | **`SignedIn`** | `0x1499e0` |
| 2 | `GetGalaxyID` | `0x148280` |
| 3–8 | famille `SignIn*` (six surcharges) | `0xff700`, `0xff1f0`, `0xff2e0`, `0xffea0`, `0xffac0`, `0xff3f0` |
| 9 | `SignOut` | `0x100190` |
| 10 | `RequestUserData` | `0x149710` |
| 11 | `GetUserData` | `0x149120` |
| 12–13 | `GetUserDataCopy` / variante | `0x148540`, `0x148b20` |
| 14 | `SetUserData` | `0xfee40` |
| 15 | `GetUserDataCount` | `0x148e30` |
| 16 | `GetUserDataByIndex` | `0x148850` |
| 17 | `DeleteUserData` | `0xfe900` |
| **18** | **`IsLoggedOn`** | `0x149020` |
| 19 | `RequestEncryptedAppTicket` | `0x149320` |
| 20 | `GetEncryptedAppTicket` | `0x148110` |
| 21 | `GetSessionID` | `0x1483b0` |
| 22 | `GetAccessToken` | `0x147dd0` |
| 23 | `GetAccessTokenCopy` | `0x147f60` |
| 24 | `ReportInvalidAccessToken` | `0x149300` |

Le binaire groupe **six** surcharges de `SignIn` aux slots 3 à 8, alors que la
reconstitution v1.148 en déclarait quatre et plaçait `SignIn(const char*)` au
slot 18 — précisément là où se trouve `IsLoggedOn`.

Ce que faisait l'ancien `MockUser`, s'il avait été instancié : le jeu appelant
le slot 18 pour `IsLoggedOn` aurait exécuté `SignIn(const char* serverKey)`,
qui lit RDX comme un pointeur de chaîne et ne retourne rien — le `bool` lu par
l'appelant aurait été le contenu résiduel de `al`.

---

## Comment le résolveur s'en sort à l'exécution

- `SetAchievement`, `StoreStatsAndAchievements`, `DeleteUserData`,
  `RequestEncryptedAppTicket` **écrivent une trace** : leur slot est identifié
  en cherchant, dans chaque fonction de la vtable, une référence RIP-relative
  vers la chaîne qui porte leur nom.
- `SignedIn` et `IsLoggedOn` sont de simples accesseurs, sans trace. Ils sont
  situés par **ancrage** sur leurs voisines :
  - `SignedIn` = (premier slot de la famille `SignIn*`) − 2 → 3 − 2 = **1**
  - `IsLoggedOn` = slot de `DeleteUserData` + 1, confirmé par
    `RequestEncryptedAppTicket` deux crans plus loin → 17 + 1 = **18**

Si un SDK futur est compilé sans ses chaînes de journal, le scan échoue
proprement, le dit dans `galaxy_proxy.log`, et retombe sur les index des
en-têtes publics — en le signalant, plutôt qu'en échouant en silence.

---

## Exports

La v1.123 exporte 26 symboles. Deux exports listés dans `Galaxy64.def` en sont
absents : la forme legacy `Init(const char*, const char*)` et `Telemetry()`.
La proxy les expose quand même et retourne une valeur neutre si le symbole
manque — c'est sans conséquence.

Un export de la v1.123 n'est pas repris : `load`, symbole non décoré issu
d'une bibliothèque statique tierce. Aucun jeu ne l'importe.
