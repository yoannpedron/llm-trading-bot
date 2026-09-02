// ============================================================================
// galaxy_proxy.cpp — Chargement de Galaxy64_o.dll, resolution, journal
//
// Le chargement est PARESSEUX, contrairement a la version precedente qui
// appelait LoadLibrary depuis DllMain. Charger une DLL sous le verrou du
// chargeur Windows est un interblocage qui attend son heure : la DLL cible
// peut a son tour vouloir charger quelque chose, et le verrou n'est pas
// reentrant entre threads. Le premier appel du jeu a une fonction exportee
// arrive forcement apres la fin de notre propre chargement, donc apres la
// liberation du verrou : c'est la que l'on charge.
// ============================================================================

#include "galaxy_proxy.h"
#include "config.h"

// WIN32_LEAN_AND_MEAN exclut les API de version : il faut les demander.
#include <winver.h>

#include <cstdio>
#include <cstdarg>
#include <cstring>
#include <ctime>

namespace proxy {

// ============================================================================
// Globales
// ============================================================================

OriginalFunctions g_original       = {};
HMODULE           g_originalModule = nullptr;

namespace {

SRWLOCK g_loadLock    = SRWLOCK_INIT;
bool    g_loadTried   = false;
bool    g_loadOk      = false;

char    g_selfDir[MAX_PATH]  = {};
char    g_logPath[MAX_PATH]  = {};
char    g_version[64]        = {};

CRITICAL_SECTION g_logLock;
bool             g_logLockInit = false;
SRWLOCK          g_logInitLock = SRWLOCK_INIT;

// Repertoire de notre propre DLL, avec le '\' final.
void ComputeSelfDirectory() {
    if (g_selfDir[0]) return;

    HMODULE self = nullptr;
    GetModuleHandleExA(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCSTR>(&ComputeSelfDirectory),
        &self);

    char path[MAX_PATH] = {};
    GetModuleFileNameA(self, path, MAX_PATH);

    char* lastSlash = std::strrchr(path, '\\');
    if (lastSlash) *(lastSlash + 1) = '\0';
    else           path[0] = '\0';

    strcpy_s(g_selfDir, path);
    std::snprintf(g_logPath, MAX_PATH, "%sgalaxy_proxy.log", g_selfDir);
}

// Version fichier de Galaxy64_o.dll, telle qu'affichee par l'explorateur.
void ReadOriginalVersion(const char* dllPath) {
    g_version[0] = '\0';

    DWORD handle = 0;
    const DWORD size = GetFileVersionInfoSizeA(dllPath, &handle);
    if (!size) return;

    // Quelques dizaines de kilo-octets au pire ; alloue sur le tas plutot
    // que sur la pile d'un thread de jeu dont on ignore la taille.
    auto* buffer = static_cast<BYTE*>(HeapAlloc(GetProcessHeap(), 0, size));
    if (!buffer) return;

    if (GetFileVersionInfoA(dllPath, handle, size, buffer)) {
        VS_FIXEDFILEINFO* info = nullptr;
        UINT len = 0;
        if (VerQueryValueA(buffer, "\\", reinterpret_cast<LPVOID*>(&info), &len) &&
            info && len >= sizeof(VS_FIXEDFILEINFO)) {
            std::snprintf(g_version, sizeof(g_version), "%u.%u.%u.%u",
                          HIWORD(info->dwFileVersionMS), LOWORD(info->dwFileVersionMS),
                          HIWORD(info->dwFileVersionLS), LOWORD(info->dwFileVersionLS));
        }
    }

    HeapFree(GetProcessHeap(), 0, buffer);
}

void WriteLog(const char* fmt, va_list args) {
    if (!g_logLockInit) {
        AcquireSRWLockExclusive(&g_logInitLock);
        if (!g_logLockInit) {
            ComputeSelfDirectory();
            InitializeCriticalSection(&g_logLock);
            g_logLockInit = true;
        }
        ReleaseSRWLockExclusive(&g_logInitLock);
    }

    EnterCriticalSection(&g_logLock);

    FILE* f = nullptr;
    if (fopen_s(&f, g_logPath, "a") == 0 && f) {
        time_t now = time(nullptr);
        struct tm t;
        localtime_s(&t, &now);
        std::fprintf(f, "[%02d:%02d:%02d] ", t.tm_hour, t.tm_min, t.tm_sec);
        std::vfprintf(f, fmt, args);
        std::fprintf(f, "\n");
        std::fclose(f);
    }

    LeaveCriticalSection(&g_logLock);
}

} // namespace

// ============================================================================
// Journal
// ============================================================================

void ProxyLog(const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    WriteLog(fmt, args);
    va_end(args);
}

void ProxyLogVerbose(const char* fmt, ...) {
    if (!config::Verbose()) return;
    va_list args;
    va_start(args, fmt);
    WriteLog(fmt, args);
    va_end(args);
}

const char* SelfDirectory() {
    ComputeSelfDirectory();
    return g_selfDir;
}

const char* OriginalDllVersion() {
    return g_version;
}

bool HasOriginalDll() {
    return g_originalModule != nullptr;
}

// ============================================================================
// Resolution des symboles
// ============================================================================
// Les noms decores sont ceux releves dans la vraie Galaxy64.dll v1.123
// (26 exports). Deux symboles presents dans des versions plus recentes en
// sont absents — la forme legacy de Init() et Telemetry() — d'ou la
// distinction entre symboles requis et optionnels : signaler bruyamment
// l'absence d'un symbole normal ne ferait qu'ensevelir les vraies erreurs.

#define RESOLVE_REQUIRED(field, mangledName)                                   \
    do {                                                                       \
        g_original.field = reinterpret_cast<decltype(g_original.field)>(       \
            GetProcAddress(g_originalModule, mangledName));                     \
        if (!g_original.field)                                                 \
            ProxyLog("ERREUR: symbole requis absent: %s", mangledName);        \
    } while (0)

#define RESOLVE_OPTIONAL(field, mangledName)                                   \
    do {                                                                       \
        g_original.field = reinterpret_cast<decltype(g_original.field)>(       \
            GetProcAddress(g_originalModule, mangledName));                     \
        if (!g_original.field)                                                 \
            ProxyLogVerbose("symbole absent (normal selon la version): %s",    \
                            mangledName);                                      \
    } while (0)

bool EnsureOriginalLoaded() {
    AcquireSRWLockShared(&g_loadLock);
    const bool alreadyTried = g_loadTried;
    const bool alreadyOk    = g_loadOk;
    ReleaseSRWLockShared(&g_loadLock);
    if (alreadyTried) return alreadyOk;

    AcquireSRWLockExclusive(&g_loadLock);
    if (g_loadTried) {
        const bool ok = g_loadOk;
        ReleaseSRWLockExclusive(&g_loadLock);
        return ok;
    }
    g_loadTried = true;

    ComputeSelfDirectory();
    config::Load();

    ProxyLog("=== Proxy Galaxy64 — interception par hooking ===");

    char path[MAX_PATH];
    std::snprintf(path, MAX_PATH, "%sGalaxy64_o.dll", g_selfDir);

    ProxyLog("Chargement de la DLL originale: %s", path);
    g_originalModule = LoadLibraryA(path);

    if (!g_originalModule) {
        // Sans la vraie DLL il n'y a plus rien a proxifier : depuis
        // l'abandon des mocks, la proxy n'implemente aucune interface et ne
        // peut donc plus fonctionner seule. C'est un choix assume — c'etait
        // le prix de l'independance vis-a-vis de la disposition des vtables.
        ProxyLog("ECHEC: Galaxy64_o.dll introuvable (erreur %lu). "
                 "Renomme la DLL originale du jeu en Galaxy64_o.dll.",
                 GetLastError());
        ReleaseSRWLockExclusive(&g_loadLock);
        return false;
    }

    ReadOriginalVersion(path);
    ProxyLog("Galaxy64_o.dll chargee (SDK %s)",
             g_version[0] ? g_version : "version inconnue");

    // --- Cycle de vie ---
    RESOLVE_REQUIRED(init,        "?Init@api@galaxy@@YAXAEBUInitOptions@12@@Z");
    RESOLVE_OPTIONAL(initLegacy,  "?Init@api@galaxy@@YAXPEBD0@Z");
    RESOLVE_REQUIRED(shutdown,    "?Shutdown@api@galaxy@@YAXXZ");
    RESOLVE_REQUIRED(processData, "?ProcessData@api@galaxy@@YAXXZ");
    RESOLVE_OPTIONAL(getError,    "?GetError@api@galaxy@@YAPEBVIError@12@XZ");

    // --- Accesseurs d'interfaces ---
    RESOLVE_REQUIRED(stats,             "?Stats@api@galaxy@@YAPEAVIStats@12@XZ");
    RESOLVE_REQUIRED(user,              "?User@api@galaxy@@YAPEAVIUser@12@XZ");
    RESOLVE_OPTIONAL(friends_,          "?Friends@api@galaxy@@YAPEAVIFriends@12@XZ");
    RESOLVE_OPTIONAL(matchmaking,       "?Matchmaking@api@galaxy@@YAPEAVIMatchmaking@12@XZ");
    RESOLVE_OPTIONAL(networking,        "?Networking@api@galaxy@@YAPEAVINetworking@12@XZ");
    RESOLVE_OPTIONAL(utils,             "?Utils@api@galaxy@@YAPEAVIUtils@12@XZ");
    RESOLVE_OPTIONAL(apps,              "?Apps@api@galaxy@@YAPEAVIApps@12@XZ");
    RESOLVE_OPTIONAL(storage,           "?Storage@api@galaxy@@YAPEAVIStorage@12@XZ");
    RESOLVE_OPTIONAL(customNetworking,  "?CustomNetworking@api@galaxy@@YAPEAVICustomNetworking@12@XZ");
    RESOLVE_OPTIONAL(logger,            "?Logger@api@galaxy@@YAPEAVILogger@12@XZ");
    RESOLVE_OPTIONAL(telemetry,         "?Telemetry@api@galaxy@@YAPEAVITelemetry@12@XZ");
    RESOLVE_OPTIONAL(chat,              "?Chat@api@galaxy@@YAPEAVIChat@12@XZ");
    RESOLVE_OPTIONAL(listenerRegistrar, "?ListenerRegistrar@api@galaxy@@YAPEAVIListenerRegistrar@12@XZ");

    // --- Serveur de jeu ---
    // Anciennement des stubs retournant nullptr. Les transmettre pour de bon
    // coute deux lignes et evite qu'un jeu Unity dont le glue SWIG les
    // appelle ne se retrouve avec des interfaces nulles.
    RESOLVE_OPTIONAL(initGameServer,        "?InitGameServer@api@galaxy@@YAXAEBUInitOptions@12@@Z");
    RESOLVE_OPTIONAL(shutdownGameServer,    "?ShutdownGameServer@api@galaxy@@YAXXZ");
    RESOLVE_OPTIONAL(processGameServerData, "?ProcessGameServerData@api@galaxy@@YAXXZ");
    RESOLVE_OPTIONAL(gameServerUser,        "?GameServerUser@api@galaxy@@YAPEAVIUser@12@XZ");
    RESOLVE_OPTIONAL(gameServerMatchmaking, "?GameServerMatchmaking@api@galaxy@@YAPEAVIMatchmaking@12@XZ");
    RESOLVE_OPTIONAL(gameServerNetworking,  "?GameServerNetworking@api@galaxy@@YAPEAVINetworking@12@XZ");
    RESOLVE_OPTIONAL(serverNetworking,      "?ServerNetworking@api@galaxy@@YAPEAVINetworking@12@XZ");
    RESOLVE_OPTIONAL(gameServerLogger,      "?GameServerLogger@api@galaxy@@YAPEAVILogger@12@XZ");
    RESOLVE_OPTIONAL(gameServerListenerRegistrar,
                     "?GameServerListenerRegistrar@api@galaxy@@YAPEAVIListenerRegistrar@12@XZ");

    g_loadOk = (g_original.stats != nullptr && g_original.user != nullptr);
    ReleaseSRWLockExclusive(&g_loadLock);
    return g_loadOk;
}

#undef RESOLVE_REQUIRED
#undef RESOLVE_OPTIONAL

} // namespace proxy
