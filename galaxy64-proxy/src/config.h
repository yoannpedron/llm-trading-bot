#pragma once
// ============================================================================
// config.h — galaxy_proxy.ini, a cote de la DLL
//
// Tout est optionnel : sans fichier, la proxy fonctionne en tout-automatique.
// L'ini sert a trois choses :
//   1. epingler un indice de vtable quand le scan echoue (jeu exotique) ;
//   2. activer le diagnostic (verbose, dump des vtables) ;
//   3. servir de cache : les indices resolus y sont ecrits, indexes par
//      version de SDK, pour eviter de rescanner a chaque lancement.
//
// Format (API GetPrivateProfile* de Windows, donc pas de parseur maison) :
//
//   [log]
//   verbose=0
//   dump_vtables=0
//
//   [stats]
//   set_achievement_index=-1     ; -1 = automatique
//   store_index=-1
//
//   [user]
//   force_signed_in=1
//   signed_in_index=-1
//   is_logged_on_index=-1
//
//   [hook]
//   mode=minhook                 ; minhook (defaut) | vtable
//
//   [cache]
//   1.123.0.0/set_achievement=8  ; ecrit automatiquement
// ============================================================================

namespace proxy {
namespace config {

// Charge (ou recharge) la configuration. Sans effet si le fichier est absent.
void Load();

// --- [log] ---
bool Verbose();
bool DumpVtables();

// --- [stats] / [user] : indices epingles, -1 si non renseigne ---
int  StatsSetAchievementIndex();
int  StatsStoreIndex();
int  UserSignedInIndex();
int  UserIsLoggedOnIndex();

// --- [user] ---
// Forcer SignedIn()/IsLoggedOn() a true. Actif par defaut : c'est la raison
// d'etre du proxy hors client GOG.
bool ForceSignedIn();

// --- [hook] ---
// true  : forcer le patch du slot de vtable ;
// false (defaut) : detour du corps de la fonction via MinHook.
// Le patch de vtable sert aussi de repli automatique si MinHook echoue
// sur une cible donnee.
bool UseVtablePatching();

// --- [cache] ---
// Indice memorise pour (version de SDK, cle), ou -1.
int  CachedIndex(const char* sdkVersion, const char* key);
// Memorise un indice resolu. Silencieux en cas d'echec d'ecriture
// (repertoire de jeu en lecture seule, par exemple).
void StoreIndex(const char* sdkVersion, const char* key, int index);

} // namespace config
} // namespace proxy
