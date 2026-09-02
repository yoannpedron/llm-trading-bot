@echo off
REM ============================================================================
REM build.bat — Compile la proxy Galaxy64.dll en une commande
REM
REM Cherche automatiquement VS Build Tools, configure CMake, compile.
REM Usage : double-cliquer ou lancer depuis un terminal.
REM ============================================================================

echo.
echo ============================================
echo   Build de Galaxy64.dll (Proxy GOG)
echo ============================================
echo.

REM --- Trouver VS Build Tools ---
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [ERREUR] Visual Studio Build Tools non trouve.
    echo          Installe-le avec : winget install Microsoft.VisualStudio.2022.BuildTools
    pause
    exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -property installationPath`) do set "VS_PATH=%%i"
if "%VS_PATH%"=="" (
    echo [ERREUR] Impossible de trouver l'installation de Visual Studio.
    pause
    exit /b 1
)
echo [OK] Visual Studio trouve : %VS_PATH%

REM --- Trouver CMake ---
set "CMAKE_EXE="
where cmake >nul 2>&1
if %ERRORLEVEL%==0 (
    set "CMAKE_EXE=cmake"
) else (
    REM CMake fourni avec VS
    for /f "usebackq tokens=*" %%i in (`dir /b /s "%VS_PATH%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" 2^>nul`) do set "CMAKE_EXE=%%i"
)
if "%CMAKE_EXE%"=="" (
    echo [ERREUR] CMake non trouve. Installe-le avec : winget install Kitware.CMake
    pause
    exit /b 1
)
echo [OK] CMake trouve : %CMAKE_EXE%

REM --- Configurer l'environnement MSVC ---
call "%VS_PATH%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

REM --- Creer le dossier build ---
cd /d "%~dp0"
if not exist build mkdir build
cd build

REM --- Configurer ---
echo.
echo [BUILD] Configuration CMake...
"%CMAKE_EXE%" .. -G "Ninja" -DCMAKE_BUILD_TYPE=Release
if %ERRORLEVEL% neq 0 (
    echo.
    echo [BUILD] Ninja non disponible, essai avec NMake...
    "%CMAKE_EXE%" .. -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release
)
if %ERRORLEVEL% neq 0 (
    echo [ERREUR] Configuration CMake echouee.
    pause
    exit /b 1
)

REM --- Compiler ---
echo.
echo [BUILD] Compilation...
"%CMAKE_EXE%" --build . --config Release
if %ERRORLEVEL% neq 0 (
    echo [ERREUR] Compilation echouee.
    pause
    exit /b 1
)

REM --- Verifier ---
echo.
echo [BUILD] Verification des exports...
where dumpbin >nul 2>&1
if %ERRORLEVEL%==0 (
    dumpbin /exports Galaxy64.dll 2>nul || dumpbin /exports Release\Galaxy64.dll 2>nul
)

echo.
echo ============================================
echo   BUILD REUSSI
echo ============================================
echo.
echo   DLL :  %cd%\Galaxy64.dll
echo.
echo   Pour tester :
echo     cd ..
echo     python test_proxy.py full
echo.
pause
