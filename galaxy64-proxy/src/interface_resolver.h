#pragma once
// ============================================================================
// interface_resolver.h — Trouver SetAchievement sans supposer son indice
//
// Le probleme
// -----------
// GOG deplace les methodes virtuelles d'une version de SDK a l'autre. Sur le
// Galaxy64.dll v1.123 de reference, la vtable reelle de IStats compte 34
// slots alors que les en-tetes v1.148 en decrivent 33, et celle de IUser
// place IsLoggedOn en 18 la ou les en-tetes le mettent en 15. Tout code qui
// code en dur un indice finit par appeler la mauvaise methode.
//
// La solution
// -----------
// Le Galaxy64.dll de GOG est compile avec ses traces : chaque methode de
// facade reference en RIP-relatif une chaine qui porte son propre nom
// ("SetAchievement: not signed in with Galaxy"). Le resolveur parcourt donc
// la vtable de l'objet REEL, et pour chaque slot demande : « le corps de
// cette fonction reference-t-il la chaine qui nomme SetAchievement ? »
// La reponse vient du binaire, pas d'une supposition.
//
// Les methodes sans trace (SignedIn, IsLoggedOn) sont localisees par
// ancrage : IsLoggedOn se trouve entre DeleteUserData et
// RequestEncryptedAppTicket, deux methodes, elles, identifiables.
//
// Ordre de priorite, du plus fiable au moins fiable :
//   1. Pinned   — indice epingle a la main dans galaxy_proxy.ini
//   2. LogString— lu dans le binaire (le cas nominal)
//   3. Anchor   — deduit de la position de voisins identifies
//   4. Pattern  — signature d'octets fournie dans l'ini
//   5. Cache    — resolution memorisee lors d'un lancement precedent
//   6. Fallback — ordre des en-tetes publics, signale bruyamment
// ============================================================================

#include <cstddef>

namespace proxy {
namespace resolve {

enum class Source {
    None,
    Pinned,
    LogString,
    Anchor,
    Pattern,
    Cache,
    Fallback
};

const char* SourceName(Source s);

struct Slot {
    int    index  = -1;        // indice dans la vtable
    void*  target = nullptr;   // adresse de la methode, thunks deroules
    void** vtable = nullptr;   // vtable de l'objet
    Source source = Source::None;

    bool Ok() const { return index >= 0 && target != nullptr && vtable != nullptr; }
};

// `stats` / `user` sont les pointeurs d'interface REELS rendus par
// Galaxy64_o.dll. Retourne un Slot inexploitable (Ok() == false) si la
// methode n'a pas pu etre localisee avec une confiance suffisante.
Slot FindStatsSetAchievement(void* stats);
Slot FindStatsStore(void* stats);
Slot FindUserSignedIn(void* user);
Slot FindUserIsLoggedOn(void* user);

// Ecrit la vtable complete dans le journal : indice, adresse, et premiere
// chaine referencee par chaque methode. Active par [log] dump_vtables=1.
//
// C'est l'outil de calibration : un lancement suffit pour lire la vraie
// disposition d'un SDK inconnu et epingler le bon indice dans l'ini.
void DumpVtable(void* object, const char* label);

} // namespace resolve
} // namespace proxy
