// ============================================================================
// config.cpp — Lecture de galaxy_proxy.ini
//
// S'appuie sur GetPrivateProfile* de kernel32 : aucun parseur maison a
// maintenir, et l'ecriture du cache est atomique du point de vue de Windows.
// ============================================================================

#include "config.h"
#include "galaxy_proxy.h"

#include <cstdio>
#include <cstring>

namespace proxy {
namespace config {

namespace {

char g_iniPath[MAX_PATH] = {};
bool g_loaded = false;

// Valeurs mises en cache au chargement : elles sont lues a chaque appel de
// SetAchievement dans le cas de Verbose(), donc autant eviter un acces
// disque par succes debloque.
bool g_verbose        = false;
bool g_dumpVtables    = false;
bool g_forceSignedIn  = true;
bool g_vtablePatching = false;   // false = MinHook (defaut)

int GetInt(const char* section, const char* key, int def) {
    if (!g_iniPath[0]) return def;
    return static_cast<int>(GetPrivateProfileIntA(section, key, def, g_iniPath));
}

} // namespace

void Load() {
    std::snprintf(g_iniPath, MAX_PATH, "%sgalaxy_proxy.ini", SelfDirectory());

    // Absence de fichier = tout automatique. GetPrivateProfile* renverra les
    // valeurs par defaut, on n'a donc rien de special a faire.
    g_verbose        = GetInt("log",  "verbose",       0) != 0;
    g_dumpVtables    = GetInt("log",  "dump_vtables",  0) != 0;
    g_forceSignedIn  = GetInt("user", "force_signed_in", 1) != 0;

    // MinHook par defaut : c'est le seul mode qui intercepte aussi les
    // appels qui ne passent pas par la vtable de l'objet.
    char mode[32] = {};
    GetPrivateProfileStringA("hook", "mode", "minhook", mode, sizeof(mode), g_iniPath);
    g_vtablePatching = (_stricmp(mode, "vtable") == 0);

    g_loaded = true;
}

bool Verbose()            { return g_loaded && g_verbose; }
bool DumpVtables()        { return g_loaded && g_dumpVtables; }
bool ForceSignedIn()      { return g_loaded ? g_forceSignedIn : true; }
bool UseVtablePatching()  { return g_loaded && g_vtablePatching; }

int StatsSetAchievementIndex() { return GetInt("stats", "set_achievement_index", -1); }
int StatsStoreIndex()          { return GetInt("stats", "store_index",           -1); }
int UserSignedInIndex()        { return GetInt("user",  "signed_in_index",       -1); }
int UserIsLoggedOnIndex()      { return GetInt("user",  "is_logged_on_index",    -1); }

// ============================================================================
// Cache : version de SDK -> indices resolus
// ============================================================================
// Cle composee "<version>/<nom>", par exemple "1.123.0.0/set_achievement".
// Une seule section [cache] suffit, et le fichier reste lisible a l'oeil.

namespace {
void MakeCacheKey(char* out, size_t outSize, const char* sdkVersion, const char* key) {
    std::snprintf(out, outSize, "%s/%s",
                  (sdkVersion && sdkVersion[0]) ? sdkVersion : "inconnue", key);
}
} // namespace

int CachedIndex(const char* sdkVersion, const char* key) {
    char full[128];
    MakeCacheKey(full, sizeof(full), sdkVersion, key);
    return GetInt("cache", full, -1);
}

void StoreIndex(const char* sdkVersion, const char* key, int index) {
    if (!g_iniPath[0] || index < 0) return;

    char full[128];
    MakeCacheKey(full, sizeof(full), sdkVersion, key);

    char value[16];
    std::snprintf(value, sizeof(value), "%d", index);

    // Echec possible et sans gravite : repertoire de jeu en lecture seule,
    // droits insuffisants. Le scan sera simplement refait au prochain
    // lancement.
    if (!WritePrivateProfileStringA("cache", full, value, g_iniPath)) {
        ProxyLogVerbose("Config: cache non ecrit (%s=%s, erreur %lu)",
                        full, value, GetLastError());
    }
}

} // namespace config
} // namespace proxy
