@echo off
setlocal

rem Runs the website locally in this terminal: PostgreSQL in Docker, then the .NET API on
rem http://localhost:5180 and the Astro dev server on http://localhost:4321, their lines marked
rem [api] and [web] (scripts\website-local.mjs). The dev server sends /api and /media to the API.
rem Ctrl+C stops both. The database container keeps running; stop it with:
rem   docker stop runova-website-dev-db

cd /d "%~dp0"

set DB_CONTAINER=runova-website-dev-db
rem Not 5432 or 5433, which a PostgreSQL installed on the machine usually takes.
set DB_PORT=55432

where docker >nul 2>&1
if errorlevel 1 (
    echo docker not found. Install Docker Desktop, it runs the website's PostgreSQL.
    pause
    exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
    echo Docker is not running. Start Docker Desktop and try again.
    pause
    exit /b 1
)
where dotnet >nul 2>&1
if errorlevel 1 (
    echo dotnet not found. Install the .NET 10 SDK, it runs the website API.
    pause
    exit /b 1
)
where bun >nul 2>&1
if errorlevel 1 (
    echo bun not found. Install it from https://bun.sh, it runs the website.
    pause
    exit /b 1
)

rem A container from an older version of this script may publish another port. Make it again; the
rem data stays in the volume.
docker container inspect %DB_CONTAINER% >nul 2>&1
if not errorlevel 1 (
    docker port %DB_CONTAINER% 5432 2>nul | findstr /c:":%DB_PORT%" >nul
    if errorlevel 1 docker rm -f %DB_CONTAINER% >nul
)

docker container inspect %DB_CONTAINER% >nul 2>&1
if errorlevel 1 (
    echo Creating the PostgreSQL container...
    docker run -d --name %DB_CONTAINER% -p %DB_PORT%:5432 ^
        -e POSTGRES_DB=runova_website -e POSTGRES_USER=runova -e POSTGRES_PASSWORD=runova ^
        -v runova-website-dev-db:/var/lib/postgresql postgres:18 >nul
    if errorlevel 1 (
        echo Failed to start PostgreSQL.
        pause
        exit /b 1
    )
) else (
    docker start %DB_CONTAINER% >nul
)

echo Waiting for PostgreSQL...
:waitdb
docker exec %DB_CONTAINER% pg_isready -U runova -d runova_website >nul 2>&1
if errorlevel 1 (
    ping -n 2 127.0.0.1 >nul
    goto waitdb
)

set ASPNETCORE_ENVIRONMENT=Development
set ASPNETCORE_URLS=http://localhost:5180
set ConnectionStrings__Default=Host=localhost;Port=%DB_PORT%;Database=runova_website;Username=runova;Password=runova
set Database__MigrateOnStart=true
set Website__SiteUrl=http://localhost:4321
set Website__MediaPath=%LOCALAPPDATA%\Runova\website-dev\media

set WEBSITE_API_URL=http://localhost:5180
set WEBSITE_API_INTERNAL_URL=http://localhost:5180

echo Starting the website API and the website...
node scripts\website-local.mjs

pause
