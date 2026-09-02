// ============================================================================
// ipc_client.cpp — Client Named Pipe non-bloquant
//
// Chaque appel ouvre le pipe, ecrit le JSON, ferme. C'est volontairement
// sans etat : pas de connexion persistante, pas de thread dedie.
// CreateFileW echoue instantanement si le pipe n'existe pas (~0 ms).
// WriteFile sur un pipe local prend <0.1 ms dans le cas normal.
// Le jeu n'est donc jamais bloque.
// ============================================================================

#include "ipc_client.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdio>
#include <cstring>
#include <ctime>

// Log interne (defini dans galaxy_proxy.cpp)
namespace proxy { void ProxyLog(const char* fmt, ...); }

namespace proxy {

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// Echappe les caracteres speciaux JSON dans `src` vers `dst`.
// Retourne le nombre d'octets ecrits (sans le '\0' terminal).
// Si le buffer est trop petit, tronque et retourne 0.
static int JsonEscape(char* dst, int dstSize, const char* src) {
    int pos = 0;
    for (const char* p = src; *p && pos < dstSize - 2; ++p) {
        switch (*p) {
            case '"':  if (pos + 2 >= dstSize) return 0; dst[pos++] = '\\'; dst[pos++] = '"';  break;
            case '\\': if (pos + 2 >= dstSize) return 0; dst[pos++] = '\\'; dst[pos++] = '\\'; break;
            case '\n': if (pos + 2 >= dstSize) return 0; dst[pos++] = '\\'; dst[pos++] = 'n';  break;
            case '\r': if (pos + 2 >= dstSize) return 0; dst[pos++] = '\\'; dst[pos++] = 'r';  break;
            case '\t': if (pos + 2 >= dstSize) return 0; dst[pos++] = '\\'; dst[pos++] = 't';  break;
            default:   dst[pos++] = *p; break;
        }
    }
    dst[pos] = '\0';
    return pos;
}

// Envoie un buffer brut au Named Pipe. Non-bloquant.
static bool SendToPipe(const char* data, int length) {
    // Tentative de connexion au pipe. Si le pipe n'existe pas (le launcher
    // n'est pas demarre), CreateFileW echoue immediatement.
    HANDLE pipe = CreateFileW(
        PIPE_NAME,
        GENERIC_WRITE,
        0,           // pas de partage
        nullptr,     // securite par defaut
        OPEN_EXISTING,
        0,           // pas d'attribut special
        nullptr      // pas de template
    );

    if (pipe == INVALID_HANDLE_VALUE) {
        DWORD err = GetLastError();
        if (err == ERROR_PIPE_BUSY) {
            // Le pipe existe mais est occupe — on pourrait attendre un peu,
            // mais on prefere ne jamais bloquer. Le prochain succes reessaiera.
            ProxyLog("IPC: pipe occupe, notification abandonnee");
        }
        // ERROR_FILE_NOT_FOUND = le launcher n'a pas cree le pipe.
        // Silencieux dans ce cas (c'est normal si le launcher n'est pas lance).
        return false;
    }

    // Ecriture du JSON
    DWORD written = 0;
    BOOL ok = WriteFile(pipe, data, static_cast<DWORD>(length), &written, nullptr);

    if (!ok || static_cast<int>(written) != length) {
        ProxyLog("IPC: ecriture partielle (%lu/%d)", written, length);
    }

    CloseHandle(pipe);
    return ok && static_cast<int>(written) == length;
}

// --------------------------------------------------------------------------
// API publique
// --------------------------------------------------------------------------

void SendAchievementNotification(const char* achievementName) {
    if (!achievementName || !achievementName[0]) return;

    // Echapper le nom du succes pour le JSON
    char escaped[256];
    if (JsonEscape(escaped, sizeof(escaped), achievementName) == 0) {
        ProxyLog("IPC: nom de succes trop long pour le buffer");
        return;
    }

    // Construire le payload JSON
    char buffer[512];
    auto ts = static_cast<long long>(std::time(nullptr));
    int len = std::snprintf(buffer, sizeof(buffer),
        R"({"event":"achievement","name":"%s","timestamp":%lld})",
        escaped, ts);

    if (len <= 0 || len >= static_cast<int>(sizeof(buffer))) {
        ProxyLog("IPC: payload trop grand");
        return;
    }

    if (SendToPipe(buffer, len)) {
        ProxyLog("IPC: succes notifie -> %s", achievementName);
    }
}

void SendStoreNotification() {
    char buffer[128];
    auto ts = static_cast<long long>(std::time(nullptr));
    int len = std::snprintf(buffer, sizeof(buffer),
        R"({"event":"store","timestamp":%lld})", ts);

    if (len > 0 && len < static_cast<int>(sizeof(buffer))) {
        SendToPipe(buffer, len);
    }
}

} // namespace proxy
