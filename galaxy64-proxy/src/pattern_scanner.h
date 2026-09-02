#pragma once
// ============================================================================
// pattern_scanner.h — Lecture du binaire charge en memoire
//
// Ce module ne connait rien au SDK GOG. Il repond a des questions de bas
// niveau sur un module PE deja charge :
//   - ou commence et finit telle fonction ? (table .pdata)
//   - cette fonction reference-t-elle telle adresse ? (RIP-relatif)
//   - ou sont les chaines commencant par tel prefixe ?
//   - ou est la sequence d'octets correspondant a telle signature ?
//
// C'est la brique sur laquelle interface_resolver.cpp identifie
// SetAchievement sans jamais supposer un indice de vtable.
// ============================================================================

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <cstdint>
#include <cstddef>

namespace proxy {
namespace scan {

// ============================================================================
// ModuleInfo — vue d'un module PE charge
// ============================================================================

struct ModuleInfo {
    uint8_t*       base      = nullptr;
    size_t         size      = 0;   // SizeOfImage

    uint8_t*       text      = nullptr;   // section executable principale
    size_t         textSize  = 0;

    uint8_t*       rdata     = nullptr;   // donnees en lecture seule
    size_t         rdataSize = 0;

    // Table des fonctions x64 (IMAGE_DIRECTORY_ENTRY_EXCEPTION), triee par
    // BeginAddress. C'est elle qui donne les bornes exactes des fonctions,
    // sans avoir a desassembler ni a deviner ou s'arrete un corps.
    const RUNTIME_FUNCTION* pdata      = nullptr;
    size_t                  pdataCount = 0;

    bool Valid() const { return base != nullptr && size != 0; }
};

// Renseigne `out` a partir des en-tetes PE du module charge.
bool GetModuleInfo(HMODULE module, ModuleInfo& out);

bool IsInsideModule(const ModuleInfo& mi, const void* p);
bool IsExecutable(const ModuleInfo& mi, const void* p);

// ============================================================================
// Fonctions
// ============================================================================

// Suit les `jmp rel32` (E9) jusqu'a la fonction reelle.
//
// Necessaire : Galaxy64.dll est lie en incrementiel, et chaque entree de
// vtable pointe vers un thunk `jmp` de 5 octets, pas vers le corps de la
// methode. Sans ce deroulement, .pdata ne trouve aucune fonction.
const uint8_t* ResolveThunk(const ModuleInfo& mi, const uint8_t* fn);

// Bornes de la fonction contenant `fn`, d'apres .pdata.
// false si `fn` n'appartient a aucune fonction repertoriee.
bool FunctionBounds(const ModuleInfo& mi, const uint8_t* fn,
                    const uint8_t** begin, const uint8_t** end);

// ============================================================================
// Chaines
// ============================================================================

// Adresses des chaines C du module dont le texte commence exactement par
// `prefix`. Une correspondance n'est retenue que si elle debute une chaine
// (octet precedent nul) et se termine par un nul dans une limite raisonnable.
//
// Retourne le nombre d'adresses ecrites dans `out`.
size_t FindStringsWithPrefix(const ModuleInfo& mi, const char* prefix,
                             const uint8_t** out, size_t maxOut);

// ============================================================================
// References
// ============================================================================

// La fonction contenant `fn` reference-t-elle l'une des `count` adresses ?
//
// Reconnait deux formes :
//   - RIP-relatif : `lea r64, [rip+disp32]` / `mov r64, [rip+disp32]` ;
//   - immediat 64 bits : `mov r64, imm64` (adresse absolue relogeable).
//
// `depth` indique combien de niveaux d'appels directs (`call rel32`) sont
// suivis. 0 suffit pour les facades de GOG, qui referencent leur chaine de
// journal directement ; 1 couvre les versions ou la methode delegue a un
// helper.
bool FunctionReferencesAny(const ModuleInfo& mi, const uint8_t* fn,
                           const uint8_t* const* targets, size_t count,
                           int depth);

// Premiere chaine C lisible referencee en RIP-relatif par la fonction.
// Sert au dump de diagnostic : c'est ce qui rend une vtable inconnue
// lisible d'un coup d'oeil, chaque facade de GOG referencant son propre nom.
// Retourne false si aucune chaine plausible n'a ete trouvee.
bool FirstReferencedString(const ModuleInfo& mi, const uint8_t* fn,
                           char* out, size_t outSize);

// ============================================================================
// Signatures d'octets
// ============================================================================

// Recherche une signature de style IDA sur la section executable :
// "48 8B 05 ?? ?? ?? ?? 48 85 C0". `??` accepte n'importe quel octet.
// Retourne l'adresse de la premiere occurrence, ou nullptr.
//
// Utilise pour les signatures fournies a la main dans galaxy_proxy.ini,
// quand un SDK depouille de ses chaines de journal resiste au scan
// automatique.
const uint8_t* FindPattern(const ModuleInfo& mi, const char* idaPattern);

// ============================================================================
// Vtables
// ============================================================================

// Nombre de pointeurs consecutifs, a partir de `vtable`, qui designent du
// code executable du module. C'est la longueur apparente de la vtable.
size_t VtableLength(const ModuleInfo& mi, void** vtable, size_t maxLen);

// Nom de classe RTTI de l'objet (".?AVStatsFacade@facade@peer@galaxy@@"),
// ou nullptr. Purement informatif : sert a rendre le journal lisible.
const char* RttiClassName(const ModuleInfo& mi, void* object);

} // namespace scan
} // namespace proxy
