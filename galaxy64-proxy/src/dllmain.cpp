// ============================================================================
// dllmain.cpp — Point d'entree et fonctions exportees de la proxy Galaxy64.dll
//
// Ce fichier ne fait plus qu'une chose : transmettre. Les exports portent les
// memes noms decores que la vraie Galaxy64.dll (voir Galaxy64.def), et
// chacun renvoie tel quel ce que rend Galaxy64_o.dll — Stats() et User()
// compris.
//
// Ce qui a change par rapport a la version a mocks
// ------------------------------------------------
// Stats() retournait un MockStats maison. Ce mock devait reimplementer toute
// l'interface IStats, donc en reconstituer la vtable ; toute divergence
// d'ordre avec le SDK reellement utilise par le jeu envoyait les appels sur
// la mauvaise methode. Confronte au vrai Galaxy64.dll v1.123, l'ecart
// commencait au slot 17 pour IStats et au slot 3 pour IUser.
//
// Desormais le jeu recoit le VRAI pointeur, avec la VRAIE vtable, et
// l'interception se fait a l'interieur (hooks.h). Il n'y a plus de vtable
// ecrite par nous, donc plus rien a desynchroniser.
// ============================================================================

#include "galaxy_types.h"
#include "galaxy_proxy.h"
#include "hooks.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace {

// Prepare la DLL originale, puis tente de poser les hooks manquants.
//
// Appele en tete des exports qui donnent acces aux interfaces. Les hooks ne
// peuvent pas etre poses depuis DllMain (les interfaces n'existent pas
// encore) ni uniquement depuis Init() (certains jeux Unity appellent Stats()
// avant que le SDK ait fini de se mettre en place).
bool Ready() {
    if (!proxy::EnsureOriginalLoaded()) return false;
    if (!proxy::hooks::Settled()) proxy::hooks::InstallAll();
    return true;
}

} // namespace

// ============================================================================
// DllMain
// ============================================================================
// Volontairement vide de toute action lourde. Ni LoadLibrary, ni pose de
// hook, ni ecriture de fichier : tout cela s'executerait sous le verrou du
// chargeur Windows.

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID reserved) {
    switch (reason) {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hModule);
        break;

    case DLL_PROCESS_DETACH:
        // reserved != nullptr signifie que le processus se termine : le
        // chargeur a deja pu detruire le CRT et les autres DLL. On ne touche
        // a rien dans ce cas.
        if (reserved == nullptr) {
            proxy::hooks::RemoveAll();
        }
        break;
    }

    return TRUE;
}

// ============================================================================
// Fonctions exportees — namespace galaxy::api
// ============================================================================
// Les signatures doivent correspondre EXACTEMENT a celles du SDK pour que le
// compilateur produise les noms decores listes dans Galaxy64.def.

namespace galaxy {
namespace api {

// --------------------------------------------------------------------------
// Cycle de vie
// --------------------------------------------------------------------------

void Init(const InitOptions& initOptions) {
    proxy::EnsureOriginalLoaded();
    proxy::ProxyLog("Init(clientID=%s)",
                    initOptions.clientID ? initOptions.clientID : "(null)");

    if (proxy::g_original.init) {
        proxy::g_original.init(&initOptions);
    }

    // Les interfaces existent des la fin de Init() : c'est le moment naturel
    // pour poser les hooks.
    proxy::hooks::InstallAll();
}

// Forme legacy. Absente du SDK v1.123 ; conservee car des versions plus
// recentes l'exportent et un jeu peut l'importer.
void Init(const char* clientID, const char* clientSecret) {
    proxy::EnsureOriginalLoaded();
    proxy::ProxyLog("Init legacy (clientID=%s)", clientID ? clientID : "(null)");

    if (proxy::g_original.initLegacy) {
        proxy::g_original.initLegacy(clientID, clientSecret);
        proxy::hooks::InstallAll();
    } else {
        proxy::ProxyLog("Init legacy indisponible dans Galaxy64_o.dll");
    }
}

void Shutdown() {
    proxy::ProxyLog("Shutdown");

    // Retirer les hooks AVANT de transmettre : apres, les vtables et le code
    // vises peuvent avoir ete liberes.
    proxy::hooks::RemoveAll();

    if (proxy::g_original.shutdown) {
        proxy::g_original.shutdown();
    }
}

void ProcessData() {
    if (!proxy::EnsureOriginalLoaded()) return;

    // Appele a chaque image : pas de journal, et le test de Settled() est un
    // simple booleen sous verrou partage. Cette relance couvre les SDK ou
    // les interfaces ne sont exploitables qu'apres quelques passes.
    if (!proxy::hooks::Settled()) proxy::hooks::InstallAll();

    if (proxy::g_original.processData) {
        proxy::g_original.processData();
    }
}

const IError* GetError() {
    if (!proxy::EnsureOriginalLoaded()) return nullptr;
    return proxy::g_original.getError
        ? static_cast<const IError*>(proxy::g_original.getError())
        : nullptr;
}

// --------------------------------------------------------------------------
// Accesseurs d'interfaces — transmission pure
// --------------------------------------------------------------------------
// Stats() et User() ne mentent plus : le jeu obtient le pointeur reel, donc
// la vtable reelle. C'est ce qui rend la proxy indifferente a la version du
// SDK.

IStats* Stats() {
    if (!Ready()) return nullptr;
    return static_cast<IStats*>(proxy::g_original.stats());
}

IUser* User() {
    if (!Ready()) return nullptr;
    return static_cast<IUser*>(proxy::g_original.user());
}

IFriends* Friends() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.friends_) return nullptr;
    return static_cast<IFriends*>(proxy::g_original.friends_());
}

IMatchmaking* Matchmaking() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.matchmaking) return nullptr;
    return static_cast<IMatchmaking*>(proxy::g_original.matchmaking());
}

INetworking* Networking() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.networking) return nullptr;
    return static_cast<INetworking*>(proxy::g_original.networking());
}

IUtils* Utils() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.utils) return nullptr;
    return static_cast<IUtils*>(proxy::g_original.utils());
}

IApps* Apps() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.apps) return nullptr;
    return static_cast<IApps*>(proxy::g_original.apps());
}

IStorage* Storage() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.storage) return nullptr;
    return static_cast<IStorage*>(proxy::g_original.storage());
}

ICustomNetworking* CustomNetworking() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.customNetworking) return nullptr;
    return static_cast<ICustomNetworking*>(proxy::g_original.customNetworking());
}

ILogger* Logger() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.logger) return nullptr;
    return static_cast<ILogger*>(proxy::g_original.logger());
}

ITelemetry* Telemetry() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.telemetry) return nullptr;
    return static_cast<ITelemetry*>(proxy::g_original.telemetry());
}

IChat* Chat() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.chat) return nullptr;
    return static_cast<IChat*>(proxy::g_original.chat());
}

IListenerRegistrar* ListenerRegistrar() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.listenerRegistrar) return nullptr;
    return static_cast<IListenerRegistrar*>(proxy::g_original.listenerRegistrar());
}

// --------------------------------------------------------------------------
// Serveur de jeu
// --------------------------------------------------------------------------
// Anciennement des stubs qui retournaient nullptr. GalaxyCSharpGlue.dll les
// importe systematiquement dans les jeux Unity ; les transmettre pour de bon
// evite de casser un jeu qui s'en servirait vraiment.

void InitGameServer(const InitOptions& initOptions) {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.initGameServer) return;
    proxy::g_original.initGameServer(&initOptions);
}

void ShutdownGameServer() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.shutdownGameServer) return;
    proxy::g_original.shutdownGameServer();
}

void ProcessGameServerData() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.processGameServerData) return;
    proxy::g_original.processGameServerData();
}

IUser* GameServerUser() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.gameServerUser) return nullptr;
    return static_cast<IUser*>(proxy::g_original.gameServerUser());
}

IMatchmaking* GameServerMatchmaking() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.gameServerMatchmaking) return nullptr;
    return static_cast<IMatchmaking*>(proxy::g_original.gameServerMatchmaking());
}

INetworking* GameServerNetworking() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.gameServerNetworking) return nullptr;
    return static_cast<INetworking*>(proxy::g_original.gameServerNetworking());
}

INetworking* ServerNetworking() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.serverNetworking) return nullptr;
    return static_cast<INetworking*>(proxy::g_original.serverNetworking());
}

ILogger* GameServerLogger() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.gameServerLogger) return nullptr;
    return static_cast<ILogger*>(proxy::g_original.gameServerLogger());
}

IListenerRegistrar* GameServerListenerRegistrar() {
    if (!proxy::EnsureOriginalLoaded() || !proxy::g_original.gameServerListenerRegistrar) return nullptr;
    return static_cast<IListenerRegistrar*>(proxy::g_original.gameServerListenerRegistrar());
}

} // namespace api
} // namespace galaxy
