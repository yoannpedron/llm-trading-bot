#pragma once
// ============================================================================
// galaxy_proxy.h — Chargement de Galaxy64_o.dll, table des exports, journal
// ============================================================================

#include "galaxy_types.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace proxy {

// ============================================================================
// OriginalFunctions — pointeurs vers les exports de Galaxy64_o.dll
// ============================================================================
// Les accesseurs d'interfaces retournent void* : la proxy ne connait plus la
// structure de ces objets, elle ne fait que les transporter.
//
// Tout symbole absent reste nullptr. C'est un cas normal, pas une erreur :
// le Galaxy64.dll v1.123 de reference n'exporte ni Telemetry() ni la forme
// legacy de Init(), alors que des versions plus recentes les exportent.

struct OriginalFunctions {
    // Cycle de vie
    void  (*init)(const galaxy::api::InitOptions*);
    void  (*initLegacy)(const char*, const char*);
    void  (*shutdown)();
    void  (*processData)();
    const void* (*getError)();

    // Accesseurs d'interfaces
    void* (*user)();
    void* (*friends_)();
    void* (*matchmaking)();
    void* (*networking)();
    void* (*stats)();
    void* (*utils)();
    void* (*apps)();
    void* (*storage)();
    void* (*customNetworking)();
    void* (*logger)();
    void* (*telemetry)();
    void* (*chat)();
    void* (*listenerRegistrar)();

    // Serveur de jeu
    void  (*initGameServer)(const galaxy::api::InitOptions*);
    void  (*shutdownGameServer)();
    void  (*processGameServerData)();
    void* (*gameServerUser)();
    void* (*gameServerMatchmaking)();
    void* (*gameServerNetworking)();
    void* (*serverNetworking)();
    void* (*gameServerLogger)();
    void* (*gameServerListenerRegistrar)();
};

extern OriginalFunctions g_original;
extern HMODULE           g_originalModule;

// ============================================================================
// Chargement
// ============================================================================

// Charge Galaxy64_o.dll et resout les symboles. Idempotent et thread-safe :
// appelable en tete de chaque fonction exportee sans surcout notable.
//
// A n'appeler QUE depuis une fonction exportee, jamais depuis DllMain :
// LoadLibrary sous le verrou du chargeur est une source classique
// d'interblocage. Le premier appel du jeu a Init()/Stats()/User() arrive
// necessairement apres la fin du chargement de notre module, donc apres la
// liberation de ce verrou.
bool EnsureOriginalLoaded();

// Vrai si Galaxy64_o.dll est chargee.
bool HasOriginalDll();

// Repertoire de notre propre DLL, termine par '\'.
// Sert au journal, au fichier de configuration et a la recherche de la
// DLL originale.
const char* SelfDirectory();

// Version fichier de Galaxy64_o.dll ("1.123.0.0"), ou "" si indisponible.
// Sert de cle de cache pour les indices de vtable resolus : un meme SDK
// donne les memes indices, inutile de rescanner a chaque lancement.
const char* OriginalDllVersion();

// ============================================================================
// Journal
// ============================================================================
// Ecrit dans galaxy_proxy.log a cote de la DLL. Format : [HH:MM:SS] message.
// Thread-safe (section critique interne).

void ProxyLog(const char* fmt, ...);

// Journal detaille : n'ecrit que si [log] verbose=1 dans galaxy_proxy.ini.
// Le scan de signatures est bavard ; ce bruit n'a sa place que pendant un
// diagnostic.
void ProxyLogVerbose(const char* fmt, ...);

} // namespace proxy
