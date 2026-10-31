# syntax=docker/dockerfile:1
# The website API (docs/epics/41-website-api.md). Built with the SDK, run on the chiseled ASP.NET
# Core runtime: no shell, no package manager, no SDK, and a non-root user. Build from this folder:
#   docker build -t runova-website-api apps/website/api

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
ARG VERSION=0.1.0

# Restore first, from the project and lock files only, so a code change keeps the restore layer.
COPY global.json nuget.config Directory.Build.props Directory.Packages.props .editorconfig ./
COPY src/Runova.Website.Core/Runova.Website.Core.csproj src/Runova.Website.Core/packages.lock.json src/Runova.Website.Core/
COPY src/Runova.Website.Data/Runova.Website.Data.csproj src/Runova.Website.Data/packages.lock.json src/Runova.Website.Data/
COPY src/Runova.Website.Api/Runova.Website.Api.csproj src/Runova.Website.Api/packages.lock.json src/Runova.Website.Api/
RUN dotnet restore src/Runova.Website.Api/Runova.Website.Api.csproj --locked-mode

COPY src/ src/
RUN dotnet publish src/Runova.Website.Api/Runova.Website.Api.csproj --no-restore --configuration Release \
    --output /app -p:UseAppHost=false -p:Version=${VERSION}

# The media folder, owned by the runtime image's app user (APP_UID, 1654), so a new volume mounted
# there starts with that owner. The chiseled image has no shell to make it in.
RUN mkdir -p /data/media

FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled AS runtime
ARG VERSION=0.1.0
WORKDIR /app
COPY --from=build --chown=1654:1654 /data /var/lib/runova
COPY --from=build /app ./
ENV ASPNETCORE_HTTP_PORTS=8080 \
    Website__MediaPath=/var/lib/runova/media \
    Sentry__Release=${VERSION}
USER 1654
EXPOSE 8080
ENTRYPOINT ["dotnet", "Runova.Website.Api.dll"]
