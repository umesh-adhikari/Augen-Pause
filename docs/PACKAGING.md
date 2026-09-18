# AugenPause – Installer & Pakete bauen

Diese Anleitung beschreibt, wie aus dem Quellcode fertige Installationsdateien für
**Windows, macOS und Linux** entstehen, welche Datei du wem gibst, wo du was bauen
kannst und was es mit Code-Signing, SmartScreen und Gatekeeper auf sich hat.

Werkzeug: **electron-builder 26** (Konfiguration: `electron-builder.yml`, Build-Ressourcen:
`build/`). Die Konfiguration ist gegen `node_modules/app-builder-lib/scheme.json` validiert.

---

## 1. Schnellstart

```bash
npm ci                 # Abhängigkeiten exakt nach package-lock.json installieren
npm test               # Unit-Tests
npm run icons          # nur nötig, wenn das App-Icon geändert wurde (assets/icons/*)

npm run pack           # nur entpackte App (dist/<plattform>-unpacked) – schneller Test
npm run dist:win       # Windows-Installer + portable .exe      (auf Windows)
npm run dist:mac       # macOS .dmg + .zip (Universal)           (nur auf einem Mac)
npm run dist:linux     # Linux .AppImage, .deb, .rpm, .tar.gz    (auf Linux / WSL2 / Docker / CI)
npm run dist           # alle Ziele des aktuellen Betriebssystems
```

Alle `dist*`-Skripte enthalten `--publish never`: electron-builder lädt **nie** etwas hoch.
Die Ergebnisse liegen in `dist/`.

Beim **ersten** Build lädt electron-builder Electron für die Zielplattform sowie
Hilfswerkzeuge (NSIS, 7-Zip, Icon-Tools …) herunter. Das dauert einige Minuten; danach
kommt alles aus dem Cache (Windows: `%LOCALAPPDATA%\electron\Cache` und
`%LOCALAPPDATA%\electron-builder\Cache`).

---

## 2. Welche Dateien entstehen – und welche gebe ich weiter?

Beispiel für Version `1.0.0` (die Version kommt aus `package.json`):

### Windows (`npm run dist:win`)

| Datei | Für wen | Hinweise |
|---|---|---|
| `AugenPause-Setup-1.0.0-x64.exe` | **Standard für fast alle Windows-PCs** | Installationsassistent (Deutsch/Englisch), Lizenzseite, wählbar „nur für mich“ (ohne Adminrechte, Standard) oder „für alle Benutzer“, Zielordner änderbar, Desktop- und Startmenü-Verknüpfung, startet die App am Ende. Deinstallation über „Apps & Features“. Einstellungen/Statistik bleiben bei der Deinstallation erhalten. |
| `AugenPause-Setup-1.0.0-arm64.exe` | Windows-on-ARM-Geräte (z. B. Snapdragon-Notebooks) | Läuft nativ statt emuliert. Die x64-Version funktioniert dort auch, nur langsamer. |
| `AugenPause-Portable-1.0.0.exe` | Ohne Installation (USB-Stick, keine Rechte zum Installieren) | Einzelne .exe, entpackt sich bei jedem Start in einen temporären Ordner (Start dauert etwas länger). Einstellungen liegen trotzdem in `%APPDATA%\AugenPause`. Keine Verknüpfungen, kein Eintrag in „Apps & Features“. Autostart funktioniert (zeigt auf die portable .exe – Datei danach nicht verschieben). |

Größe (Stand 1.0.0): Setup x64 ≈ 89 MB, Setup arm64 ≈ 83 MB, Portable ≈ 89 MB.

### macOS (`npm run dist:mac`, nur auf einem Mac oder in CI)

| Datei | Für wen | Hinweise |
|---|---|---|
| `AugenPause-1.0.0-universal.dmg` | **Standard** | Ein Download für Intel- und Apple-Silicon-Macs. Öffnen → AugenPause auf den „Applications“-Ordner ziehen. |
| `AugenPause-1.0.0-universal.zip` | Alternative | Entpacken, `AugenPause.app` nach „Programme“ verschieben. |

*Universal* bedeutet: x64 und arm64 in einer App (doppelte Größe, dafür keine falsche
Download-Wahl möglich). Getrennte Pakete wären mit `arch: [x64, arm64]` statt `universal`
unter `mac.target` in `electron-builder.yml` möglich (Dateien heißen dann `…-x64.dmg` /
`…-arm64.dmg`).

### Linux (`npm run dist:linux`, auf Linux / WSL2 / Docker / CI)

| Datei | Für wen | Installation |
|---|---|---|
| `AugenPause-1.0.0-x86_64.AppImage` | **Jede Distribution**, ohne Installation | `chmod +x AugenPause-1.0.0-x86_64.AppImage` und starten |
| `AugenPause-1.0.0-arm64.AppImage` | ARM64-Geräte (z. B. Raspberry Pi 5 mit 64-Bit-OS) | wie oben |
| `AugenPause-1.0.0-amd64.deb` | **Ubuntu, Debian, Linux Mint, Pop!_OS …** | `sudo apt install ./AugenPause-1.0.0-amd64.deb` |
| `AugenPause-1.0.0-arm64.deb` | Debian/Ubuntu auf ARM64 | `sudo apt install ./AugenPause-1.0.0-arm64.deb` |
| `AugenPause-1.0.0-x86_64.rpm` | **Fedora, openSUSE, RHEL/Rocky/Alma** | `sudo dnf install ./AugenPause-1.0.0-x86_64.rpm` bzw. `sudo zypper install ./…rpm` |
| `AugenPause-1.0.0-x64.tar.gz` | Fortgeschrittene / andere Distributionen | entpacken, `./augenpause` starten (kein Menüeintrag) |

`.deb` und `.rpm` installieren nach `/opt/AugenPause`, legen einen Menüeintrag an und
ziehen die nötigen Bibliotheken (GTK, NSS, libnotify, ALSA, AppIndicator …) automatisch nach.
Deinstallation: `sudo apt remove augenpause` bzw. `sudo dnf remove augenpause`.

### Nicht weitergeben

`dist/*-unpacked/` (entpackte Test-Apps), `builder-debug.yml`, `*.blockmap`,
`*__uninstaller*.exe` und `.icon-*`-Ordner sind Zwischenprodukte.

---

## 3. Wo kann ich was bauen?

Geprüft am Quellcode von electron-builder 26.15.3 (`node_modules/app-builder-lib`) und
durch Test-Builds auf Windows 11:

| Build-Rechner → | Windows-Ziele | macOS-Ziele | Linux-Ziele |
|---|---|---|---|
| **Windows** | ✅ Setup + Portable (x64 **und** arm64) | ❌ bricht ab: „Build for macOS is supported only on macOS“ | ❌ AppImage/deb/rpm nicht möglich (fpm/mksquashfs gibt es nicht für Windows); `tar.gz` entsteht zwar, aber **ohne Ausführungsrechte** → unbrauchbar |
| **macOS** | ⚠️ nur mit Wine (nicht empfohlen) | ✅ dmg + zip (universal), Signierung/Notarisierung | ⚠️ teilweise (nicht empfohlen) |
| **Linux** (auch WSL2 / Docker) | ⚠️ nur mit Wine (nicht empfohlen) | ❌ (dmg und Signierung brauchen macOS) | ✅ AppImage, deb, rpm, tar.gz (x64 und arm64) |
| **CI (GitHub Actions)** | ✅ `windows-latest` | ✅ `macos-latest` | ✅ `ubuntu-latest` |

Faustregel: **Jedes Betriebssystem baut seine eigenen Pakete.** Ohne Mac führt der Weg zu
macOS-Paketen nur über CI (Abschnitt 5).

Da die App keine nativen Node-Module hat, können Pakete für die andere CPU-Architektur
(arm64 auf x64-Rechnern) problemlos mitgebaut werden.

### Nur x64 unter Windows bauen

`npm run dist:win` baut laut Konfiguration x64 **und** arm64. `--x64` allein reicht nicht,
weil die Architekturen in `electron-builder.yml` pro Ziel festgelegt sind. Nur x64:

```bash
npx electron-builder --win nsis portable --x64 --publish never
```

### Linux-Pakete unter Windows: WSL2

```bash
# in WSL2 (Ubuntu), einmalig:
sudo apt-get update
sudo apt-get install -y --no-install-recommends rpm libarchive-tools
# Node.js 24 installieren (z. B. mit nvm)

# Projekt ins Linux-Dateisystem kopieren (NICHT unter /mnt/c bauen: langsam und
# ohne korrekte Dateirechte), node_modules und dist dabei auslassen:
mkdir -p ~/augenpause
tar -C /mnt/c/Users/<Benutzer>/Documents/AugenPause --exclude=node_modules --exclude=dist -cf - . | tar -C ~/augenpause -xf -

cd ~/augenpause
npm ci
npm run dist:linux
cp dist/AugenPause-* /mnt/c/Users/<Benutzer>/Desktop/
```

### Linux-Pakete unter Windows: Docker

Baut in einem Wegwerf-Container (Docker Desktop, Linux-Container); das Windows-`node_modules`
bleibt unangetastet, gebaut wird im Container-Dateisystem (korrekte Dateirechte), die fertigen
Dateien landen in `dist/linux/` (PowerShell, im Projektordner):

```powershell
docker run --rm -v "${PWD}:/src:ro" -v "${PWD}/dist/linux:/out" node:24-bookworm bash -c "apt-get update && apt-get install -y --no-install-recommends rpm libarchive-tools && mkdir /build && tar -C /src --exclude=node_modules --exclude=dist -cf - . | tar -C /build -xf - && cd /build && npm ci && npm run dist:linux && cp dist/AugenPause-* /out/"
```

---

## 4. Was die Konfiguration festlegt

- **Inhalt der App** (`files`): nur `src/**`, `assets/icons/**` und `package.json` landen im
  Paket – `scripts/`, `docs/`, `test/`, `.github/` und Source-Maps nicht. Alles liegt in
  `resources/app.asar`.
- **Icons**: Windows nutzt `assets/icons/icon.ico` (handoptimierte Größen 16–256 px, auch für
  Installer/Uninstaller). macOS (`.icns`) und Linux (Icon-Größen für den Menüeintrag) werden
  beim Build automatisch aus `assets/icons/icon.png` (1024 px) erzeugt. Nach Icon-Änderungen:
  `npm run icons`, dann neu bauen.
- **Sprachen**: nur die Chromium-Sprachdateien für Deutsch und Englisch werden mitgeliefert
  (spart Platz). Der Windows-Installer erscheint auf deutschem Windows auf Deutsch, sonst
  auf Englisch.
- **Electron-Fuses** (Härtung, siehe `docs/ARCHITECTURE.md` §7): im fertigen Paket sind
  *RunAsNode*, `NODE_OPTIONS` und `--inspect` deaktiviert, die App lädt nur aus `app.asar`
  und prüft dessen Integrität (Windows/macOS). **Folge:** `app.asar` nach dem Build nicht
  verändern – sonst startet die App nicht mehr. Prüfen lassen sich die Fuses mit
  `npx @electron/fuses read --app dist/win-unpacked/AugenPause.exe`.
- **Kein Auto-Update, kein Upload** (`publish: null`).
- **Uninstaller (Windows)**: `build/installer.nsh` entfernt bei einer echten Deinstallation den
  Autostart-Eintrag („Beim Anmelden starten“) aus der Registry; bei Updates bleibt er.
- **Wayland (Linux)**: Menüeinträge starten die App mit `--ozone-platform=x11` (siehe Abschnitt 7).

---

## 5. Optional: automatisch bauen mit GitHub Actions

Die Datei `.github/workflows/build.yml` ist **nur relevant, wenn du das Projekt in ein eigenes
(privates) GitHub-Repository hochlädst**. Lokal hat sie keine Wirkung. Sie baut auf echten
Windows-, macOS- und Linux-Rechnern – der einfachste Weg zu **allen** Installern ohne eigenen Mac.

**Ablauf**

1. Version in `package.json` erhöhen (z. B. `1.0.1`) und committen. Die Dateinamen
   verwenden **immer die Version aus `package.json`**, nicht den Tag-Namen.
2. Tag setzen und hochladen:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. Der Workflow läuft auf drei Runnern: `npm ci` → `npm test` → Build.
4. Danach erstellt der Job „Draft release“ einen **Release-Entwurf** mit allen Installern und
   `SHA256SUMS.txt` (Prüfsummen). Entwurf prüfen, Beschreibung ergänzen, veröffentlichen.

**Weitere Auslöser**

- **Pull Requests**: bauen und testen, aber **ohne Secrets und ohne Signierung**; die Dateien
  liegen 14 Tage im Workflow-Lauf unter „Artifacts“.
- **Manuell** („Actions“ → „Build“ → „Run workflow“): wie ein PR-Build, aber mit Signierung,
  falls Secrets hinterlegt sind; kein Release.

**Kosten (private Repositories):** Actions-Minuten sind begrenzt; macOS- und Windows-Minuten
werden deutlich höher angerechnet als Linux-Minuten. Ein kompletter Lauf dauert grob 10–20 Minuten.

**Optionale Secrets** (Repository → Settings → Secrets and variables → Actions):

| Secret | Zweck |
|---|---|
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows-Zertifikat (.pfx, base64) |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | macOS „Developer ID Application“-Zertifikat (.p12, base64) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarisierung (nur zusammen mit `MAC_CSC_LINK`) |

Ohne Secrets entstehen unsignierte, voll funktionsfähige Pakete (`CSC_IDENTITY_AUTO_DISCOVERY=false`).

**Sicherheit des Workflows**

- Minimale Rechte: global `contents: read`, nur der Release-Job bekommt `contents: write`.
- Kein `pull_request_target`; Secrets werden nur an Nicht-PR-Builds und nur an die passende
  Plattform übergeben; `persist-credentials: false` beim Checkout.
- **Empfehlung: Actions auf Commit-SHAs festnageln.** Tags wie `@v4` können nachträglich
  verschoben werden. Sicherer ist die volle, 40-stellige Commit-ID mit Versionskommentar, z. B.
  `uses: actions/checkout@<40-stelliger-Commit-SHA> # v4.x.y` – die SHA steht auf der
  Release-Seite der jeweiligen Action. Updates danach z. B. per Dependabot
  (`package-ecosystem: github-actions`).

---

## 6. Code-Signing & Notarisierung

Ohne Zertifikate bauen alle Ziele erfolgreich – die Pakete sind nur **unsigniert**. Das ist für
den privaten Gebrauch völlig in Ordnung, erzeugt aber Warnungen beim ersten Start.

### Windows: SmartScreen

Unsignierte (oder neu signierte, noch „unbekannte“) Programme zeigen beim Start:

> **Der Computer wurde durch Windows geschützt** – Microsoft Defender SmartScreen hat den Start
> einer unbekannten App verhindert.

→ **„Weitere Informationen“** → **„Trotzdem ausführen“**. Das gilt für Setup und Portable.
Auch Browser warnen eventuell („wird nicht häufig heruntergeladen“) → „Beibehalten“.

Signieren (optional):

- **Zertifikat als .pfx**: `WIN_CSC_LINK` (Pfad oder base64) und `WIN_CSC_KEY_PASSWORD` setzen,
  dann `npm run dist:win`. Hinweis: Neue Code-Signing-Zertifikate öffentlicher CAs werden seit
  2023 nur noch mit Hardware-/Cloud-Schlüssel ausgegeben; ein exportierbares .pfx gibt es dann
  nicht mehr.
- **Cloud-Signierung**, z. B. Azure Trusted Signing: in `electron-builder.yml` unter `win`
  `azureSignOptions` (`publisherName`, `endpoint`, `codeSigningAccountName`,
  `certificateProfileName`) eintragen und die Azure-Anmeldedaten per Umgebungsvariablen
  (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) bereitstellen.
- Eine Signatur verhindert SmartScreen nicht sofort – die Reputation baut sich über
  Downloads auf.

### macOS: Gatekeeper

Ohne Apple-Developer-Zertifikat ist die App nur „ad-hoc“ signiert (automatisch beim Build,
nötig für Apple Silicon) und nicht notarisiert. Beim ersten Öffnen blockiert macOS:

- **macOS 14 und älter:** im Finder **Rechtsklick (Ctrl-Klick) auf AugenPause → „Öffnen“** →
  im Dialog nochmals „Öffnen“. Danach startet die App normal.
- **macOS 15 (Sequoia) und neuer:** Rechtsklick → Öffnen reicht nicht mehr. App einmal öffnen
  (wird blockiert) → **Systemeinstellungen → Datenschutz & Sicherheit** → unten
  **„Dennoch öffnen“** → mit Passwort bestätigen.
- **Alternative im Terminal** (alle Versionen, auch bei „… ist beschädigt“):
  ```bash
  xattr -dr com.apple.quarantine /Applications/AugenPause.app
  ```

Signieren + notarisieren (optional, **Apple Developer Program** nötig):

1. Zertifikat **„Developer ID Application“** erstellen und als `.p12` exportieren.
2. App-spezifisches Passwort für die Apple-ID anlegen (appleid.apple.com) und die Team-ID notieren.
3. Auf dem Mac bauen:
   ```bash
   export CSC_LINK=/pfad/zu/developer-id.p12
   export CSC_KEY_PASSWORD='…'
   export APPLE_ID='…'
   export APPLE_APP_SPECIFIC_PASSWORD='…'
   export APPLE_TEAM_ID='…'
   npm run dist:mac -- -c.mac.notarize=true
   ```
   `notarize` steht in der Konfiguration bewusst auf `false`, damit Builds ohne Zugangsdaten
   nie scheitern. Statt Apple-ID geht auch ein App-Store-Connect-API-Key
   (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).

Signiert wird mit **Hardened Runtime** und minimalen Entitlements
(`build/entitlements.mac.plist`: nur `com.apple.security.cs.allow-jit` für die
JavaScript-Engine; keine Kamera, kein Mikrofon, keine Netzwerk-Sonderrechte).

### Linux

Keine Signierung nötig. Wer Prüfsummen weitergibt: `sha256sum AugenPause-*` (in CI automatisch
als `SHA256SUMS.txt`).

---

## 7. Hinweise für Linux

- **AppImage**
  - Vor dem ersten Start ausführbar machen: `chmod +x AugenPause-1.0.0-x86_64.AppImage`
    (oder Dateimanager → Eigenschaften → „Als Programm ausführen“).
  - Benötigt FUSE 2. Fehlt es („dlopen(): error loading libfuse.so.2“):
    Ubuntu 22.04 `sudo apt install libfuse2`, Ubuntu 24.04+ `sudo apt install libfuse2t64`.
    Notlösung ohne FUSE: `./AugenPause-….AppImage --appimage-extract-and-run`.
  - Auf Systemen ohne unprivilegierte User-Namespaces (z. B. Ubuntu 24.04 mit AppArmor-Sperre)
    startet die AppImage automatisch mit `--no-sandbox`. Wer das nicht möchte, nimmt unter
    Ubuntu/Debian die **.deb** – sie installiert ein passendes AppArmor-Profil.
  - Ein Menüeintrag entsteht erst mit Integrations-Tools wie AppImageLauncher oder Gear Lever.
- **Tray-Symbol unter GNOME**: GNOME zeigt ohne Erweiterung keine Tray-Symbole.
  Ubuntu bringt die Erweiterung mit („Ubuntu AppIndicators“, aktiv). Auf Fedora, Debian & Co.
  die Erweiterung **„AppIndicator and KStatusNotifierItem Support“** installieren
  (z. B. `sudo dnf install gnome-shell-extension-appindicator` bzw.
  `sudo apt install gnome-shell-extension-appindicator`), in der App „Erweiterungen“
  aktivieren, ab- und wieder anmelden. KDE, Cinnamon, XFCE und MATE brauchen nichts.
  Ohne Tray bleibt AugenPause über das Widget und das Dashboard voll bedienbar.
- **Wayland**: Das schwebende Widget (immer im Vordergrund, frei positionierbar) funktioniert
  unter nativem Wayland nicht zuverlässig. Deshalb starten die Menüeinträge von `.deb`, `.rpm`
  und integrierter AppImage die App mit **`--ozone-platform=x11`** (über XWayland).
  Beim **direkten Start aus dem Terminal** oder aus dem `tar.gz` die Option selbst angeben:
  ```bash
  ./AugenPause-1.0.0-x86_64.AppImage --ozone-platform=x11
  ./augenpause --ozone-platform=x11
  ```
- **tar.gz**: Auf Systemen mit gesperrten User-Namespaces braucht die Sandbox-Hilfsdatei
  Root-Rechte: `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`.
- **RHEL/Rocky/Alma**: Die AppIndicator-Bibliothek ist dort nur über EPEL verfügbar; sie ist im
  `.rpm` deshalb nur eine *empfohlene* Abhängigkeit und blockiert die Installation nicht.

---

## 8. Entwicklung: `npm start` im VS-Code-Terminal

Manche Umgebungen (z. B. das integrierte Terminal von VS Code, je nach Start von VS Code bzw.
Erweiterungen) setzen die Variable **`ELECTRON_RUN_AS_NODE=1`**. Dann startet `electron .` als
reines Node.js – `npm start` bricht mit Fehlern wie „Cannot read properties of undefined“ ab
oder es passiert nichts.

Lösung – Variable für den Aufruf entfernen:

```powershell
# PowerShell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npm start
```

```bash
# Git Bash / Linux / macOS
env -u ELECTRON_RUN_AS_NODE npm start
```

**Builds sind nicht betroffen:** electron-builder startet die App nicht, und im fertigen Paket
ist die Fuse *RunAsNode* abgeschaltet – dort wird die Variable ignoriert.

---

## 9. Fehlerbehebung

| Meldung / Problem | Ursache & Lösung |
|---|---|
| `Build for macOS is supported only on macOS` | macOS-Pakete auf einem Mac oder per CI bauen (Abschnitt 3/5). |
| `cannot find specified resource "assets/icons/icon.png"` bzw. `icon.ico` | Icons fehlen → `npm run icons`. |
| `EBUSY` / `EPERM` / „Datei wird verwendet“ in `dist/` | AugenPause aus `dist/…-unpacked` läuft noch (Tray → Beenden) oder der Virenscanner prüft gerade; `dist/` löschen und erneut bauen. |
| Download-Fehler beim ersten Build | Netzwerk/Proxy prüfen; erneut starten (Downloads werden gecacht). |
| `rpmbuild` / `Need executable 'rpmbuild'` | Linux: `sudo apt-get install rpm` (Debian/Ubuntu). |
| App startet nach manueller Änderung an `app.asar` nicht | Gewollt (Integritätsprüfung) → neu bauen statt Dateien im Paket zu ändern. |
| Linux: Widget springt / bleibt nicht im Vordergrund | Ohne `--ozone-platform=x11` unter Wayland gestartet (Abschnitt 7). |

---

## 10. Release-Checkliste

1. Version in `package.json` erhöhen.
2. `npm ci && npm test`
3. Falls Icons geändert: `npm run icons`
4. Bauen: lokal `npm run dist:win` (+ Mac/Linux) **oder** Tag `vX.Y.Z` pushen (CI).
5. Installer auf einem sauberen System/VM testen (Installation, Start, Tray, Autostart,
   Deinstallation).
6. Prüfsummen erzeugen (CI: `SHA256SUMS.txt`) und Dateien weitergeben:
   Windows → `AugenPause-Setup-X.Y.Z-x64.exe`, macOS → `AugenPause-X.Y.Z-universal.dmg`,
   Linux → `.deb` (Ubuntu/Debian), `.rpm` (Fedora/openSUSE) oder `.AppImage` (alle anderen).
