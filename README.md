# AugenPause

Moderne Augenpausen- und Trink-Erinnerung für **Windows, macOS und Linux**.
AugenPause erinnert dich regelmäßig daran, vom Bildschirm wegzuschauen (standardmäßig alle 30 Minuten
für 2 Minuten, jede 4. Pause ist eine lange Pause mit 10 Minuten) und genug Wasser zu trinken, ohne dich
dabei jemals mitten in einem Meeting zu überraschen.

*English summary: see [below](#english).*

---

## Funktionen

- **Augenpausen nach Plan**: Voreinstellungen *Halbstündlich* (30 Min / 2 Min), *Stündlich* (60 / 5),
  *20-20-20* (20 Min / 20 s) und *Pomodoro* (25 / 5) oder komplett benutzerdefiniert, inkl. langer Pausen.
- **Pausenbildschirm**: transparenter Sperrbildschirm auf allen Monitoren – du siehst deinen Desktop durch
  einen dunklen Schleier (Deckkraft einstellbar, 20–100 %) – mit geführten Augenübungen, Countdown und sanftem
  Gong. Optional ohne Sperre (nur Benachrichtigung + Widget).
- **Pflicht-Pause** (standardmäßig an): Eine laufende Pause endet nur durch Zeitablauf – kein Überspringen,
  kein Verschieben, kein Beenden. Der Meeting-Schutz greift davor. Details: [Pflicht-Pause](#pflicht-pause).
- **Analoguhr-Widget**: schwebende, verschiebbare Uhr mit Fortschrittsring bis zur nächsten Pause,
  drei Größen, immer im Vordergrund (abschaltbar).
- **Trink-Erinnerung**: Intervall, Tagesziel und Glasgröße einstellbar, Gläser per Klick (Widget, Menü, Benachrichtigung) eintragen.
- **Dashboard**: Übersicht, Einstellungen, Statistik (Pausen, Bildschirmzeit, Wasser), Augenübungen.
- **Abwesenheitserkennung**: Wer lange genug weg war, hat bereits Pause gemacht, der Timer startet neu.
- **Arbeitszeiten**: Erinnerungen nur an ausgewählten Tagen und Uhrzeiten.
- **Systemintegration**: Tray-/Menüleisten-Symbol mit Kontextmenü, globale Tastenkürzel, native
  Benachrichtigungen, Autostart.
- **Design**: dunkles und helles Theme (oder automatisch), sechs Akzentfarben, Deutsch und Englisch.
- **Update-Hinweis**: AugenPause sagt Bescheid, wenn es eine neuere Version gibt – die einzige
  Netzwerkverbindung der App, abschaltbar. Details: [Updates](#updates).

## Pflicht-Pause

Die **Pflicht-Pause** ist standardmäßig eingeschaltet (*Einstellungen → Pausen*, umschaltbar nur, solange keine
Pause läuft). Ihr Grundsatz: Eine Pause, die läuft, endet **ausschließlich durch Zeitablauf**. Der Schutz vor
ungünstigen Momenten passiert komplett **vor** der Pause.

Der Sperrbildschirm ist dabei **transparent**: Über dem Desktop liegt ein dunkler Schleier, dessen **Deckkraft**
sich von 20 % bis 100 % einstellen lässt (*Einstellungen → Pausen → Transparenz des Sperrbildschirms*). Du siehst
also weiter, was auf dem Bildschirm passiert – Mausklicks und Tastatureingaben landen aber immer auf dem
Pausenbildschirm, nie in den Fenstern darunter. Übungen, Countdown und Texte sitzen auf einer lesbaren Glasfläche,
unabhängig von der gewählten Deckkraft.

**Während einer Pflicht-Pause geht bewusst nichts davon:**

| Versuch                                                     | Verhalten während der Pflicht-Pause                                   |
|-------------------------------------------------------------|-----------------------------------------------------------------------|
| `Esc`                                                       | wirkungslos – verschiebt die Pause **nicht**                          |
| Pause überspringen / beenden (Knopf, Menü, Tray)            | nicht vorhanden bzw. deaktiviert                                      |
| Pause verschieben (Menü, Tastenkürzel, Benachrichtigung)    | abgelehnt                                                             |
| Erinnerungen pausieren / Meeting-Modus                      | abgelehnt – eine Meeting-Freigabe gibt es erst nach der Pause         |
| AugenPause beenden (Menü, `Alt+F4`, `⌘Q`)                   | blockiert – nur Abmelden/Herunterfahren des Systems beendet die App   |
| Einstellungen ändern oder zurücksetzen                      | nur **Sprache** und **Design** (Theme, Akzentfarbe); alles andere wird abgelehnt |
| Dashboard öffnen                                            | bleibt geschlossen; stattdessen kommt der Pausenbildschirm nach vorn  |
| `Alt+Tab`, `Win+D`, virtuelle Desktops, Startmenü           | der Pausenbildschirm holt sich den Fokus zurück                       |
| Wasser eintragen („Getrunken“)                              | **funktioniert weiter** – das ist die einzige erlaubte Aktion         |

**Vorher hast du alle Freiheit** (siehe [Meeting-Schutz](#meeting-schutz)): die Vorwarnung (standardmäßig
60 Sekunden) mit einem Klick zum Verschieben – im Widget, in der Benachrichtigung, im Menü oder per Tastenkürzel,
begrenzt durch die maximale Anzahl an Verschiebungen – sowie der automatische Meeting-Aufschub, solange Kamera
oder Mikrofon benutzt werden (bis maximal 2 Stunden), und der manuelle Meeting-Modus.

**Und die ehrlichen Grenzen:**

- `Strg+Alt+Entf`, `Win+L` (bzw. `Ctrl+⌘+Q` auf macOS) und der Ein-/Ausschalter bleiben aus Sicherheitsgründen
  immer erreichbar. AugenPause sperrt ein Fenster über den Desktop, es ist **keine** Systemsperre, keine
  Kindersicherung und kein Kiosk-Modus.
- Wer den Prozess abschießt (Task-Manager, `kill`), ist die Pause nicht los: Die laufende Pause liegt in
  `session.json` im Benutzerprofil und wird beim nächsten Start **innerhalb von 8 Stunden fortgesetzt** – mit der
  Restzeit, die noch offen war. Die Zeit ohne laufende App zählt nicht als Pause. Wurde die App dagegen durch
  Abmelden oder Herunterfahren beendet, wird die Pause nur fortgesetzt, wenn du innerhalb der Abwesenheitsdauer
  (*Einstellungen → Abwesenheit*, standardmäßig 5 Minuten) zurück bist – sonst hattest du ohnehin eine echte Pause.
- Die Transparenz braucht unter **Linux einen laufenden Compositor** (X11 mit Compositing oder Wayland über
  XWayland). Ohne Compositor zeichnet das Fenster einen deckenden dunklen Hintergrund – die Sperre funktioniert,
  nur die Durchsicht fehlt.
- Ist die Pflicht-Pause ausgeschaltet, gilt das frühere Verhalten: Schonfrist am Pausenanfang, **Esc** verschiebt,
  Überspringen durch Gedrückthalten, und ein Meeting beendet eine laufende Pause.

## Meeting-Schutz

Eine Pause darf dich nie mitten in einem Call überraschen. Dafür gibt es mehrere Sicherheitsebenen:

1. **Vorwarnung**: Standardmäßig 60 Sekunden vor jeder Pause. Das Widget zeigt einen Verschieben-Knopf
   (ist das Widget ausgeblendet, erscheint es während der Vorwarnung kurz), die Benachrichtigung sagt
   „Klicken zum Verschieben um 5 Min“, und im Menü steht „Pause verschieben“ ganz oben.
2. **Schonfrist** (nur ohne Pflicht-Pause): In den ersten 15 Sekunden jeder Pause lässt sie sich immer
   verschieben, auch wenn das Verschiebe-Limit erreicht ist. **Esc** verschiebt die Pause sofort; das funktioniert
   auch dann, wenn der Pausenbildschirm selbst hängt. Lädt der Pausenbildschirm nicht, schließt er sich nach
   spätestens 10 Sekunden von selbst. Mit eingeschalteter Pflicht-Pause gibt es beides nicht – dafür bleibt der
   Pausenbildschirm auch dann stehen, wenn seine Oberfläche hängt, und schließt sich am Ende der Pause.
3. **Tastenkürzel** `Strg+Alt+F9` (Linux `Strg+Umschalt+Alt+S`, macOS `⌃⌥⌘S`): verschiebt die anstehende Pause,
   jederzeit – während einer Pflicht-Pause bleibt es wirkungslos.
4. **Automatische Meeting-Erkennung** (Menü „Meetings automatisch erkennen“, standardmäßig an):
   - **Windows**: Kamera oder Mikrofon wird gerade von einer App benutzt (Windows-Datenschutzstatus).
   - **Linux**: Mikrofon wird aufgenommen (PulseAudio/PipeWire) oder eine Kamera (`/dev/video*`) ist geöffnet.
   - **macOS**: Eine Call-App hält den Bildschirm wach (Zoom, Microsoft Teams, Webex, FaceTime, Slack, Discord)
     oder ein Browser hat aktive WebRTC-Verbindungen (z. B. Google Meet, Teams im Browser).

   Wird eine Pause während eines Meetings fällig, wird sie **nach dem Meeting nachgeholt** (mit neuer
   Vorwarnung), spätestens aber nach 2 Stunden. Beginnt ein Meeting während einer laufenden Pause, wird sie
   ohne Pflicht-Pause sofort beendet und später nachgeholt – eine Pflicht-Pause läuft weiter.
   Es wird nur geprüft, *ob* Geräte benutzt werden, niemals Bild oder Ton.
5. **Meeting-Modus**: Menü „Meeting-Modus / Pausieren“ → 30 Minuten, 1 Stunde, 2 Stunden, bis morgen oder
   bis du fortsetzt.

## Installation & Entwicklung

Voraussetzungen: [Node.js](https://nodejs.org) 22 oder neuer (inkl. npm).

Im Projektordner:

```bash
npm install     # Abhängigkeiten (Electron, electron-builder) installieren
npm start       # App starten
npm run dev     # App im Entwicklungsmodus starten
npm test        # Unit-Tests (reines Node, ohne Electron)
npm run icons   # App- und Tray-Icons neu erzeugen (scripts/build-icons.js, ohne Abhängigkeiten)
```

> **Hinweis für VS Code**: Im integrierten Terminal ist manchmal `ELECTRON_RUN_AS_NODE` gesetzt. Electron
> startet dann als reines Node und die App öffnet sich nicht. Abhilfe:
>
> ```bash
> env -u ELECTRON_RUN_AS_NODE npm start          # bash / zsh
> ```
>
> ```powershell
> Remove-Item Env:ELECTRON_RUN_AS_NODE; npm start   # PowerShell
> ```

## Installer bauen

Ausführliche Anleitung (Zielformate, Code-Signing, CI): **[docs/PACKAGING.md](docs/PACKAGING.md)**.
Kurzfassung, jeweils auf dem passenden Betriebssystem:

```bash
npm run dist:win     # Windows: Installer (x64 + arm64) und portable .exe
npm run dist:mac     # macOS:   DMG + ZIP (x64 und arm64 getrennt)
npm run dist:linux   # Linux:   AppImage, .deb, .rpm, .tar.gz
```

Die Ergebnisse landen im Ordner `dist/`.

## Bedienung

| Wo                      | Aktion                   | Wirkung                                        |
|-------------------------|--------------------------|------------------------------------------------|
| Widget                  | Klick                    | Dashboard öffnen                               |
| Widget                  | Ziehen                   | Widget verschieben (Position wird gespeichert) |
| Widget                  | Rechtsklick              | Kontextmenü                                    |
| Tray (Windows/Linux)    | Klick                    | Dashboard ein-/ausblenden                      |
| Tray (Windows/Linux)    | Rechtsklick              | Kontextmenü                                    |
| Menüleiste (macOS)      | Klick                    | Kontextmenü; neben dem Symbol steht die Restzeit (z. B. „12m“) |
| Pausenbildschirm        | „Getrunken“              | Glas Wasser eintragen (geht auch in der Pflicht-Pause) |
| Pausenbildschirm        | Knopf gedrückt halten    | Pause überspringen (nur ohne Pflicht-Pause)    |
| Pausenbildschirm        | Esc                      | Pause verschieben (nur ohne Pflicht-Pause: in der Schonfrist immer, sonst solange Verschieben erlaubt ist) |

Das Kontextmenü enthält außerdem: Jetzt Pause machen (kurz/lang), Pause verschieben (+5/+10/+15/+30 Min),
Nächste Pause überspringen, Timer zurücksetzen, Meeting-Modus / Pausieren, Wasser eintragen, Intervall,
Bildschirmsperre, Pflicht-Pause, Widget-Optionen, Trink-Erinnerung, Dashboard, Einstellungen, Statistik,
„Nach Updates suchen“ (und, solange eine neuere Version bereitsteht, „Update verfügbar: 1.2.3“)
und Beenden. Während einer Pflicht-Pause zeigt die erste Zeile „Pflicht-Pause – noch 1:23“ und alle Einträge
außer den Wasser-Einträgen sind ausgegraut.

## Tastenkürzel

Globale Tastenkürzel funktionieren auch, wenn AugenPause nicht im Vordergrund ist
(abschaltbar unter *Einstellungen → Allgemein*).

| Aktion                                   | Windows        | macOS           | Linux                  |
|------------------------------------------|----------------|-----------------|------------------------|
| Pause verschieben (Standard: 5 Minuten)  | `Strg+Alt+F9`  | `⌃⌥⌘S`          | `Strg+Umschalt+Alt+S`  |
| Erinnerungen pausieren / fortsetzen      | `Strg+Alt+F10` | `⌃⌥⌘P`          | `Strg+Umschalt+Alt+P`  |
| Dashboard ein-/ausblenden                | `Strg+Alt+F11` | `⌃⌥⌘D`          | `Strg+Umschalt+Alt+D`  |

Bewusst ohne `Strg+Alt+<Buchstabe>`: Unter Windows entspricht das AltGr (z. B. für `{`, `|`, `@`) und kollidiert
mit vielen IDE-Kürzeln; unter Linux wechselt `Strg+Alt+F<n>` die virtuelle Konsole. „Jetzt Pause machen“ und
„Wasser eintragen“ gibt es im Kontextmenü und im Widget.

Ist ein Kürzel bereits von einer anderen App belegt, wird es übersprungen, alle übrigen bleiben aktiv.

## Updates

AugenPause prüft, ob im GitHub-Repository eine neuere Version veröffentlicht wurde. **Das ist die einzige
Netzwerkverbindung der App** – und sie lässt sich abschalten.

**Was passiert genau**

- Angefragt wird ausschließlich `https://api.github.com/repos/umesh-adhikari/Augen-Pause/releases`
  (nur HTTPS, 10 Sekunden Zeitlimit, Antwort auf 256 KB begrenzt, Ergebnis streng geprüft).
- Zeitpunkt: rund 30 Sekunden nach dem Start und danach alle 24 Stunden (einstellbar, 6–168 Stunden).
  Während einer Pflicht-Pause wird nicht geprüft, sondern später.
- **Gesendet wird nichts außer der Anfrage selbst**: kein Konto, kein Token, keine Cookies, keine Kennung,
  keine Statistik, keine Einstellungen, keine Telemetrie. Technisch unvermeidbar sind nur die Angaben jeder
  HTTPS-Anfrage: deine IP-Adresse und der Kopf `User-Agent: AugenPause/<Version>`.
- Gibt es keine neuere Version, passiert nichts. Gibt es eine, erscheint einmal pro Version eine
  Benachrichtigung und im Menü der Eintrag „Update verfügbar: 1.2.3“.

**Was installiert wird – und was nicht**

| Installationsart                  | Verhalten                                                                  |
|-----------------------------------|----------------------------------------------------------------------------|
| Windows-Setup (NSIS)              | kann das Update auf Wunsch laden und beim Beenden installieren              |
| Linux AppImage                    | kann das Update auf Wunsch laden und beim Beenden installieren              |
| Windows portable, macOS, deb, rpm | **die App lädt nichts herunter und führt nichts aus** – sie öffnet die passende Datei bzw. die Release-Seite im Browser, alles Weitere machst du selbst |

Heruntergeladen wird auch in den ersten beiden Fällen nur, wenn du es anstößt (oder „Updates automatisch
herunterladen“ einschaltest); installiert wird erst beim nächsten Beenden. Nie während einer Pflicht-Pause.
Externe Links öffnet die App nur, wenn sie mit
`https://github.com/umesh-adhikari/Augen-Pause/releases/` beginnen – alles andere wird abgelehnt.

**Abschalten**: *Einstellungen → Updates → „Automatisch nach Updates suchen“* ausschalten
(entspricht `updates.autoCheck: false` in der `settings.json`). Danach geht **keine einzige** Verbindung
mehr raus; die manuelle Suche im Menü bleibt natürlich möglich.

| Einstellung                          | Bedeutung                                              | Standard |
|--------------------------------------|--------------------------------------------------------|----------|
| `updates.autoCheck`                  | automatisch suchen                                     | an       |
| `updates.intervalHours`              | Abstand zwischen zwei Prüfungen (6–168 Stunden)        | 24       |
| `updates.autoDownload`               | gefundenes Update sofort laden (nur Setup / AppImage)  | aus      |
| `updates.includePrerelease`          | auch Vorabversionen anbieten                           | aus      |

## Sicherheit & Datenschutz

- **Alles bleibt lokal**: Einstellungen (`settings.json`), Statistik (`stats.json`) und eine laufende
  Pflicht-Pause (`session.json`) liegen als JSON-Dateien im Benutzerprofil (Windows `%APPDATA%\AugenPause`,
  macOS `~/Library/Application Support/AugenPause`, Linux `~/.config/AugenPause`).
- **Genau eine Netzwerkverbindung – die Update-Prüfung**: AugenPause fragt bei
  `https://api.github.com/repos/umesh-adhikari/Augen-Pause/releases` nach neueren Versionen. Gesendet wird
  dabei nichts außer der Anfrage selbst (kein Konto, kein Token, keine Cookies, keine Kennung, keine
  Telemetrie); abschaltbar unter *Einstellungen → Updates*. Auf macOS, portabel, deb und rpm lädt und
  startet die App **keine** Installer. Details: [Updates](#updates).
- **Sonst nichts nach draußen**: kein Konto, keine Telemetrie, keine Werbung, keine externen Schriftarten
  oder Skripte; die Oberflächen selbst dürfen per Content-Security-Policy (`connect-src 'none'`) gar keine
  Verbindung aufbauen – die Prüfung läuft ausschließlich im Hauptprozess.
- **Gehärtete Oberfläche**: Alle Fenster laufen in der Chromium-Sandbox mit Context Isolation und ohne
  Node-Zugriff, Inhalte kommen nur über ein eigenes `app://`-Protokoll, strikte Content-Security-Policy,
  jede IPC-Nachricht wird geprüft; Navigation, neue Fenster, Downloads und Berechtigungsanfragen sind gesperrt.
  Im Installer sind riskante Electron-Fuses (z. B. *RunAsNode*) deaktiviert.
- **Pausensperre = Overlay**: Die „Bildschirmsperre“ ist ein transparentes Vollbild-Fenster, keine Systemsperre.
  `Strg+Alt+Entf`, `Win+L` (bzw. `Ctrl+⌘+Q` auf macOS) und der Ein-/Ausschalter bleiben aus Sicherheitsgründen
  immer verfügbar – siehe [Pflicht-Pause](#pflicht-pause).
- **Meeting-Erkennung**: liest nur den Nutzungsstatus von Kamera/Mikrofon bzw. Energiespar-Zusicherungen von
  Call-Apps, nie Bild- oder Tondaten. Abschaltbar im Menü.

## Plattform-Hinweise

- **Windows**: Benachrichtigungen erscheinen nicht, solange „Nicht stören“/Fokus aktiv ist. Das Tray-Symbol
  passt sich hellen und dunklen Taskleisten an. Autostart funktioniert auch mit der portablen Version.
- **macOS**: Nicht signierte Builds beim ersten Start per Rechtsklick → *Öffnen* starten. Benachrichtigungen
  müssen ggf. in den Systemeinstellungen erlaubt werden.
- **Linux (Wayland)**: Positionierung und „Immer im Vordergrund“ des Widgets funktionieren nur über XWayland.
  Die installierten Starter (Menüeintrag, AppImage-Integration, Autostart) verwenden deshalb
  `--ozone-platform=x11`. Beim manuellen Start das Flag selbst angeben, z. B.
  `./AugenPause-*.AppImage --ozone-platform=x11` bzw. `npm start -- --ozone-platform=x11`.
  Globale Tastenkürzel werden unter reinem Wayland nicht von allen Desktops unterstützt.
- **Linux (Transparenz)**: Der durchscheinende Pausenbildschirm braucht einen laufenden Compositor (X11 mit
  Compositing, z. B. `picom`, oder Wayland über XWayland). Fehlt er, ist das Fenster deckend dunkel; gesperrt
  wird der Bildschirm trotzdem.
- **Linux (GNOME)**: Für das Tray-Symbol wird die Erweiterung *AppIndicator and KStatusNotifierItem Support*
  benötigt (unter Ubuntu vorinstalliert). KDE, Cinnamon, XFCE u. a. unterstützen das Symbol direkt.
- **Linux Autostart**: wird als `~/.config/autostart/augenpause.desktop` eingerichtet.

## Architektur

Electron (Hauptprozess CommonJS, Oberflächen als native ES-Module), praktisch keine Laufzeit-Abhängigkeiten:
Die einzige ist `electron-updater`, und sie wird ausschließlich dann geladen, wenn ein Update tatsächlich
installiert werden kann (Windows-Setup, Linux-AppImage). Fehlt das Paket, verhält sich die App wie bei allen
anderen Installationsarten – sie öffnet die Release-Seite im Browser statt selbst etwas herunterzuladen.
Schnittstellen, Einstellungen, Zustandsmodell und Sicherheitsregeln sind in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** beschrieben.

```
src/main/        Hauptprozess: Timer-Logik, Einstellungen, Statistik, Fenster, Tray, Menü, Benachrichtigungen
src/preload/     sichere Brücke zwischen Oberfläche und Hauptprozess
src/renderer/    Widget, Dashboard, Pausenbildschirm, gemeinsame Styles
assets/icons/    App- und Tray-Icons (erzeugt von scripts/build-icons.js)
test/            Unit-Tests (node --test)
```

## Lizenz

[MIT](LICENSE) – Copyright © 2026 Umesh Adhikari. Nutzung, Änderung und Weitergabe sind frei,
solange der Copyright-Hinweis erhalten bleibt. Ohne Gewährleistung.

## Mitmachen & Sicherheit

- Fehler melden oder Code beisteuern: [CONTRIBUTING.md](CONTRIBUTING.md)
- Sicherheitslücken **nicht** als öffentliches Issue, sondern über
  [Security → Report a vulnerability](https://github.com/umesh-adhikari/Augen-Pause/security/advisories/new)
  melden: [SECURITY.md](SECURITY.md)

---

## English

**AugenPause** reminds you to rest your eyes (by default a 2-minute break every 30 minutes, every 4th break is
a 10-minute long break) and to drink water. It features a floating analog-clock widget, a dashboard with
statistics and eye exercises, a transparent fullscreen break screen on all displays, a tray menu, global
shortcuts and native notifications. The UI is available in German and English (follows the system language by
default).

**Mandatory break** ("Pflicht-Pause", on by default, *Settings → Breaks*, switchable only while no break is
running): a break that has started ends **only when its time is up**. The lock screen is *transparent* – a dark
tint over your desktop whose **opacity** you set between 20 % and 100 % ("Transparenz des Sperrbildschirms"), so
you still see what happens on screen while every click and key lands on the break screen.

During a mandatory break the following is deliberately impossible: **Esc** does nothing, there is no skip and no
snooze (button, menu, tray, global shortcut and notifications are all rejected), pausing reminders / meeting mode
is rejected, quitting AugenPause is blocked (only an OS logout/shutdown ends the app – the break is saved first),
the dashboard stays closed (the break screen comes to the front instead), and settings can only be changed for
**language** and **appearance** (theme, accent) – everything else, including a reset, is rejected. Alt+Tab, Win+D,
virtual desktops and the start menu are countered by a focus watchdog. Logging a glass of water keeps working.

**Before** the break you have every freedom (see meeting safety below): the pre-break warning with one-click
snooze (up to the configured snooze limit), the automatic deferral while a camera or microphone is in use (up to
2 hours) and the manual meeting mode.

**Honest limits**: `Ctrl+Alt+Del`, `Win+L` (`Ctrl+⌘+Q` on macOS) and the power button always stay available – this
is a window over your desktop, not a system lock, not parental control, not a kiosk mode. Killing the process
(Task Manager, `kill`) does not get rid of the break: it is stored in `session.json` and **resumed on the next
start within 8 hours** with the time that was left (time without the app running is not credited; after a regular
logout/shutdown it is only resumed when you are back within the configured away time, otherwise you had a real
break anyway). The see-through tint needs a running compositor on **Linux** (X11 with compositing or Wayland via
XWayland) – without one the window is opaque, but still locks the screen.

**Meeting safety**: a pre-break warning with one-click snooze, the global snooze shortcut, automatic meeting
detection (camera/microphone in use on Windows and Linux, call apps or browser WebRTC calls on macOS; due breaks
follow after the meeting, at the latest after 2 hours) and a manual meeting mode (pause for 30 min / 1 h / 2 h /
until resumed). Without the mandatory break there is also a 15-second grace period at the start of every break
(snooze always allowed, **Esc** snoozes, a break screen that fails to load closes itself within 10 s) and a
meeting starting during a break ends it.

**Development** (from the project folder): `npm install`, `npm start`, `npm test`. In VS Code terminals
`ELECTRON_RUN_AS_NODE` may be set; start with `env -u ELECTRON_RUN_AS_NODE npm start` or run
`Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell first.

**Installers**: `npm run dist:win`, `npm run dist:mac`, `npm run dist:linux`; details in
[docs/PACKAGING.md](docs/PACKAGING.md).

**Shortcuts** (global, can be switched off):

| Action                     | Windows        | macOS  | Linux              |
|----------------------------|----------------|--------|--------------------|
| Snooze break               | `Ctrl+Alt+F9`  | `⌃⌥⌘S` | `Ctrl+Shift+Alt+S` |
| Pause / resume reminders   | `Ctrl+Alt+F10` | `⌃⌥⌘P` | `Ctrl+Shift+Alt+P` |
| Show / hide dashboard      | `Ctrl+Alt+F11` | `⌃⌥⌘D` | `Ctrl+Shift+Alt+D` |

`Ctrl+Alt+<letter>` is avoided on purpose (AltGr on Windows, IDE conflicts; `Ctrl+Alt+F<n>` switches virtual
terminals on Linux). "Break now" and "log a glass of water" are available in the context menu and the widget.
All three shortcuts are no-ops while a mandatory break is running.

**Updates**: AugenPause checks `https://api.github.com/repos/umesh-adhikari/Augen-Pause/releases` for a newer
version – about 30 seconds after start and then every 24 hours (6–168 h, configurable). **This is the only
network connection the app makes**, and it can be switched off (*Settings → Updates*, `updates.autoCheck`).
Nothing but the request itself is sent: no account, no token, no cookies, no identifier, no telemetry – only
what any HTTPS request carries (your IP address and the header `User-Agent: AugenPause/<version>`). The
Windows setup install and the Linux AppImage can download an update and install it on quit (only when you ask
for it, never during a mandatory break); on macOS, the portable Windows build and deb/rpm the app **never
downloads or runs an installer** – it opens the matching file or the release page in your browser. External
links are only ever opened when they start with `https://github.com/umesh-adhikari/Augen-Pause/releases/`.

**Privacy & security**: everything else stays on your computer, the renderers cannot open any connection at all
(CSP `connect-src 'none'`), they are sandboxed with context isolation and no Node access. The break lock is a
transparent overlay window, not a system lock; `Ctrl+Alt+Del` / `Win+L` and the power button always remain
available.

**Platform notes**: on Linux/Wayland use `--ozone-platform=x11` (the installed launchers already do); on GNOME
the tray icon requires the AppIndicator extension.

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
Security policy: [SECURITY.md](SECURITY.md). License: [MIT](LICENSE) – Copyright © 2026 Umesh Adhikari.
