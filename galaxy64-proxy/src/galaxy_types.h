#pragma once
// ============================================================================
// galaxy_types.h — Types minimaux du SDK GOG Galaxy
//
// Depuis l'abandon du mocking C++, la proxy n'IMPLEMENTE plus aucune
// interface du SDK. Elle ne fait que les transporter. Les interfaces sont
// donc declarees OPAQUES (forward declarations) : c'est delibere.
//
// Pourquoi c'est important
// ------------------------
// L'ancienne version reconstituait a la main les vtables de IStats et IUser.
// Confrontee au vrai Galaxy64.dll v1.123, cette reconstitution s'est revelee
// fausse a partir du slot 17 pour IStats (IsAchievementVisibleWhileLocked
// n'existe pas dans cette version) et a partir du slot 3 pour IUser
// (six surcharges de SignIn groupees, IsLoggedOn en 18 et non en 15).
// Voir docs/vtables_1.123.md pour la cartographie complete, obtenue en
// lisant le binaire.
//
// En declarant les interfaces opaques, cette classe de bugs disparait par
// construction : il n'existe plus de vtable ecrite par nous. Les seuls
// indices qui subsistent sont ceux de repli du resolveur, et ils sont
// systematiquement confrontes au binaire avant usage.
//
// Ce qui DOIT rester exact ici :
//   - le layout binaire de GalaxyID et InitOptions (traversent la frontiere
//     de la DLL) ;
//   - le nom et la nature (class/struct) de chaque type, car ils entrent
//     dans les noms decores MSVC listes dans Galaxy64.def.
// ============================================================================

#include <cstdint>
#include <cstddef>

namespace galaxy {
namespace api {

// ============================================================================
// GalaxyID — identifiant 64 bits (utilisateur, lobby, serveur)
// ============================================================================
// Layout : [63:56] = IDType, [55:0] = identifiant reel.
// Type valeur : 8 octets, copiable, comparable.

class GalaxyID {
public:
    enum IDType : uint8_t {
        ID_TYPE_UNASSIGNED = 0,
        ID_TYPE_LOBBY      = 1,
        ID_TYPE_USER       = 2,
        ID_TYPE_SERVER     = 3
    };

    static constexpr uint64_t UNASSIGNED_VALUE = 0;

    GalaxyID() : m_value(UNASSIGNED_VALUE) {}
    GalaxyID(uint64_t value) : m_value(value) {}

    uint64_t ToUint64()  const { return m_value; }
    uint64_t GetRealID() const { return m_value & 0x00FFFFFFFFFFFFFFULL; }
    IDType   GetIDType() const { return static_cast<IDType>((m_value >> 56) & 0xFF); }
    bool     IsValid()   const { return m_value != UNASSIGNED_VALUE; }

    bool operator==(const GalaxyID& o) const { return m_value == o.m_value; }
    bool operator!=(const GalaxyID& o) const { return m_value != o.m_value; }
    bool operator< (const GalaxyID& o) const { return m_value <  o.m_value; }

private:
    uint64_t m_value;
};

// ============================================================================
// Interfaces du SDK — OPAQUES
// ============================================================================
// Aucune methode virtuelle n'est declaree : la proxy ne fait que faire
// transiter ces pointeurs. Les noms restent obligatoires, car ils
// apparaissent dans les noms decores des exports (Galaxy64.def).

class IUser;
class IFriends;
class IMatchmaking;
class INetworking;
class IStats;
class IUtils;
class IApps;
class IStorage;
class ICustomNetworking;
class ILogger;
class ITelemetry;
class IChat;
class IListenerRegistrar;
class IError;

// Types opaques cites par InitOptions
class GalaxyAllocator;
class IGalaxyThreadFactory;

// ============================================================================
// InitOptions — parametres d'initialisation du SDK
// ============================================================================
// Le layout DOIT correspondre au struct du SDK : le jeu construit cette
// structure chez lui et nous la passe par reference constante ; nous la
// retransmettons telle quelle a la vraie DLL.

struct InitOptions {
    const char*            clientID;
    const char*            clientSecret;
    const char*            configFilePath;
    const char*            storagePath;
    const char*            host;
    uint16_t               port;
    GalaxyAllocator*       galaxyAllocator;
    IGalaxyThreadFactory*  galaxyThreadFactory;
    bool                   throwExceptions;
};

} // namespace api
} // namespace galaxy
