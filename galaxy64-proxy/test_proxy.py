#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_proxy.py — Test end-to-end de la proxy Galaxy64.dll

Deux modes :

  1. python test_proxy.py server
     Lance le serveur Named Pipe et affiche les notifications recues.
     A lancer EN PREMIER, avant le jeu.

  2. python test_proxy.py simulate
     Charge la proxy DLL et simule ce que fait un jeu GOG :
     Init() -> SetAchievement("TEST_ACH") -> StoreStatsAndAchievements()
     A lancer PENDANT que le serveur tourne (dans un autre terminal).

  3. python test_proxy.py full
     Lance le serveur en arriere-plan, puis simule le jeu.
     Test complet en une seule commande.

Aucune dependance externe : que stdlib Python + ctypes (API Windows).
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import threading
import time

# ============================================================================
# Constantes Windows (Named Pipes)
# ============================================================================

PIPE_NAME = r"\\.\pipe\GogLauncherAchievements"

# CreateNamedPipe
PIPE_ACCESS_INBOUND    = 0x00000001
PIPE_TYPE_BYTE         = 0x00000000
PIPE_READMODE_BYTE     = 0x00000000
PIPE_WAIT              = 0x00000000
PIPE_UNLIMITED_INSTANCES = 255
INVALID_HANDLE_VALUE   = ctypes.c_void_p(-1).value

kernel32 = ctypes.windll.kernel32

# ============================================================================
# Serveur Named Pipe (cote launcher)
# ============================================================================

def create_pipe():
    """Cree le Named Pipe en tant que serveur."""
    handle = kernel32.CreateNamedPipeW(
        PIPE_NAME,
        PIPE_ACCESS_INBOUND,                        # lecture seule
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        PIPE_UNLIMITED_INSTANCES,
        4096,    # taille buffer sortie
        4096,    # taille buffer entree
        0,       # timeout par defaut
        None     # securite par defaut
    )
    if handle == INVALID_HANDLE_VALUE:
        err = kernel32.GetLastError()
        print(f"[ERREUR] CreateNamedPipe echoue (code {err})")
        return None
    return handle


def pipe_server(stop_event=None, results=None):
    """Ecoute les notifications sur le Named Pipe.

    Args:
        stop_event: threading.Event pour arreter le serveur.
        results: liste ou stocker les messages recus (pour les tests).
    """
    print(f"[SERVEUR] En ecoute sur {PIPE_NAME}")
    print(f"[SERVEUR] En attente de connexion...")

    count = 0
    max_messages = 10 if stop_event else 999

    while count < max_messages:
        if stop_event and stop_event.is_set():
            break

        pipe = create_pipe()
        if pipe is None:
            time.sleep(1)
            continue

        # Attente d'une connexion client (bloquant)
        connected = kernel32.ConnectNamedPipe(pipe, None)
        if not connected and kernel32.GetLastError() != 535:  # ERROR_PIPE_CONNECTED
            kernel32.CloseHandle(pipe)
            continue

        # Lecture des donnees
        buf = ctypes.create_string_buffer(4096)
        bytes_read = wt.DWORD(0)
        ok = kernel32.ReadFile(pipe, buf, 4096, ctypes.byref(bytes_read), None)

        if ok and bytes_read.value > 0:
            raw = buf.raw[:bytes_read.value].decode("utf-8", errors="replace")
            count += 1
            try:
                msg = json.loads(raw)
                event = msg.get("event", "?")
                if event == "achievement":
                    name = msg.get("name", "?")
                    print(f"[RECU #{count}] SUCCES DEBLOQUE : {name}")
                elif event == "store":
                    print(f"[RECU #{count}] Stats sauvegardees")
                else:
                    print(f"[RECU #{count}] Evenement inconnu : {raw}")

                if results is not None:
                    results.append(msg)
            except json.JSONDecodeError:
                print(f"[RECU #{count}] JSON invalide : {raw}")

        # Deconnexion propre
        kernel32.DisconnectNamedPipe(pipe)
        kernel32.CloseHandle(pipe)

    print(f"[SERVEUR] Arrete ({count} message(s) recu(s))")


# ============================================================================
# Simulation du jeu (charge la proxy DLL)
# ============================================================================

def find_proxy_dll():
    """Cherche Galaxy64.dll dans les emplacements probables."""
    candidates = [
        os.path.join(os.path.dirname(__file__), "build", "Galaxy64.dll"),
        os.path.join(os.path.dirname(__file__), "build", "Release", "Galaxy64.dll"),
        os.path.join(os.path.dirname(__file__), "build", "Debug", "Galaxy64.dll"),
        os.path.join(os.path.dirname(__file__), "Galaxy64.dll"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return os.path.abspath(p)
    return None


def simulate_game():
    """Simule un jeu GOG qui appelle le SDK Galaxy."""
    dll_path = find_proxy_dll()
    if not dll_path:
        print("[ERREUR] Galaxy64.dll introuvable. As-tu compile ?")
        print("         Chemins cherches :")
        print("           build/Release/Galaxy64.dll")
        print("           build/Debug/Galaxy64.dll")
        print("           Galaxy64.dll")
        return False

    print(f"[JEU] Chargement de {dll_path}")

    # Charger la DLL
    try:
        dll = ctypes.CDLL(dll_path)
    except OSError as e:
        print(f"[ERREUR] Impossible de charger la DLL : {e}")
        return False

    # Les noms decores MSVC x64 — les memes que dans Galaxy64.def
    MANGLED = {
        "Init":          "?Init@api@galaxy@@YAXPEBD0@Z",
        "Stats":         "?Stats@api@galaxy@@YAPEAVIStats@12@XZ",
        "Shutdown":      "?Shutdown@api@galaxy@@YAXXZ",
        "ProcessData":   "?ProcessData@api@galaxy@@YAXXZ",
    }

    # --- Init (forme legacy: clientID, clientSecret) ---
    print("[JEU] Appel de Init('test_client', 'test_secret')...")
    try:
        fn_init = getattr(dll, MANGLED["Init"])
        fn_init.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        fn_init.restype = None
        fn_init(b"test_client", b"test_secret")
        print("[JEU] Init OK")
    except Exception as e:
        print(f"[JEU] Init echoue (normal sans Galaxy64_o.dll) : {e}")

    # --- Stats() -> IStats* ---
    print("[JEU] Appel de Stats()...")
    try:
        fn_stats = getattr(dll, MANGLED["Stats"])
        fn_stats.restype = ctypes.c_void_p
        stats_ptr = fn_stats()
        print(f"[JEU] Stats() -> 0x{stats_ptr:016X}" if stats_ptr else "[JEU] Stats() -> NULL")
    except Exception as e:
        print(f"[JEU] Stats() echoue : {e}")
        stats_ptr = None

    if stats_ptr:
        # Le vtable de IStats : chaque entree est un pointeur de fonction (8 octets sur x64).
        # On veut appeler SetAchievement qui est a l'index 8 dans le vtable
        # (apres destructeur, RequestUserStatsAndAchievements, GetStatInt, GetStatFloat,
        #  SetStatInt, SetStatFloat, UpdateAvgRateStat, GetAchievement).
        #
        # Layout memoire de l'objet :
        #   [0..7]   = pointeur vers le vtable
        # Layout du vtable :
        #   [0]  = destructeur (~IStats)
        #   [1]  = RequestUserStatsAndAchievements
        #   [2]  = GetStatInt
        #   [3]  = GetStatFloat
        #   [4]  = SetStatInt
        #   [5]  = SetStatFloat
        #   [6]  = UpdateAvgRateStat
        #   [7]  = GetAchievement
        #   [8]  = SetAchievement      <-- celui qu'on veut
        #   [9]  = ClearAchievement
        #   [10] = StoreStatsAndAchievements

        VTABLE_INDEX_SET_ACHIEVEMENT = 8
        VTABLE_INDEX_STORE = 10

        # Lire le pointeur vtable (premier champ de l'objet)
        vtable_ptr = ctypes.c_uint64.from_address(stats_ptr).value

        # Lire l'adresse de SetAchievement dans le vtable
        set_ach_addr = ctypes.c_uint64.from_address(
            vtable_ptr + VTABLE_INDEX_SET_ACHIEVEMENT * 8
        ).value

        # Construire le type de la fonction : void SetAchievement(IStats* this, const char* name)
        # Sur x64 MSVC, __thiscall passe 'this' dans RCX (comme __fastcall).
        FUNCTYPE_SET_ACH = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_char_p)
        fn_set_ach = FUNCTYPE_SET_ACH(set_ach_addr)

        # Appeler SetAchievement avec plusieurs succes
        achievements = [b"ACH_FIRST_BLOOD", b"ACH_EXPLORER", b"ACH_MASTER"]
        for ach in achievements:
            print(f"[JEU] SetAchievement('{ach.decode()}')")
            fn_set_ach(stats_ptr, ach)
            time.sleep(0.2)  # petit delai pour que le pipe server ait le temps

        # Appeler StoreStatsAndAchievements
        store_addr = ctypes.c_uint64.from_address(
            vtable_ptr + VTABLE_INDEX_STORE * 8
        ).value
        # void StoreStatsAndAchievements(IStats* this, IStatsAndAchievementsStoreListener* listener)
        FUNCTYPE_STORE = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)
        fn_store = FUNCTYPE_STORE(store_addr)
        print("[JEU] StoreStatsAndAchievements()")
        fn_store(stats_ptr, None)
        time.sleep(0.2)

    # --- Shutdown ---
    print("[JEU] Appel de Shutdown()...")
    try:
        fn_shutdown = getattr(dll, MANGLED["Shutdown"])
        fn_shutdown.restype = None
        fn_shutdown()
        print("[JEU] Shutdown OK")
    except Exception as e:
        print(f"[JEU] Shutdown echoue : {e}")

    print("[JEU] Simulation terminee")
    return True


# ============================================================================
# Test complet (serveur + simulation)
# ============================================================================

def full_test():
    """Lance le serveur en arriere-plan puis simule le jeu."""
    results = []
    stop = threading.Event()

    # Demarrer le serveur dans un thread
    server_thread = threading.Thread(target=pipe_server, args=(stop, results), daemon=True)
    server_thread.start()
    time.sleep(0.5)  # laisser le pipe se creer

    # Simuler le jeu
    ok = simulate_game()
    time.sleep(1)  # laisser le temps au serveur de tout recevoir

    # Arreter le serveur
    stop.set()

    # Bilan
    print()
    print("=" * 60)
    if not ok:
        print("ECHEC : la DLL n'a pas pu etre chargee")
        return False

    ach_count = sum(1 for r in results if r.get("event") == "achievement")
    store_count = sum(1 for r in results if r.get("event") == "store")

    print(f"RESULTATS : {ach_count} succes recu(s), {store_count} store recu(s)")

    if ach_count == 3 and store_count == 1:
        print("TEST REUSSI — l'IPC fonctionne parfaitement")
        return True
    elif ach_count > 0:
        print("TEST PARTIEL — des notifications sont arrivees")
        return True
    else:
        print("TEST ECHOUE — aucune notification recue")
        return False


# ============================================================================
# Point d'entree
# ============================================================================

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage :")
        print("  python test_proxy.py server    — lance le serveur pipe")
        print("  python test_proxy.py simulate  — simule un jeu (apres 'server')")
        print("  python test_proxy.py full      — test complet automatique")
        sys.exit(1)

    mode = sys.argv[1].lower()

    if mode == "server":
        try:
            pipe_server()
        except KeyboardInterrupt:
            print("\n[SERVEUR] Arret par Ctrl+C")

    elif mode == "simulate":
        simulate_game()

    elif mode == "full":
        success = full_test()
        sys.exit(0 if success else 1)

    else:
        print(f"Mode inconnu : {mode}")
        sys.exit(1)
