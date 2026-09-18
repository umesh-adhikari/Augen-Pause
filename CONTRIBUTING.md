# Mitmachen / Contributing

Beiträge sind willkommen – Fehlerberichte genauso wie Code. *Contributions are welcome;
issues and pull requests can be in German or English.*

## Schnellstart

```bash
npm install
npm start          # App starten (VS Code: env -u ELECTRON_RUN_AS_NODE npm start)
npm test           # 261 Unit-Tests, reines Node, kein Electron nötig
```

Einzelne Ansichten lassen sich ohne den Hauptprozess mit Testdaten rendern:

```bash
npx electron scripts/dev/preview.js --view overlay --scenario break --backdrop --out shot.png
# --view widget|dashboard|overlay   --scenario work|warning|break|paused|meeting|…
```

## Vor einem Pull Request

1. **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) lesen.** Das Dokument ist der verbindliche
   Vertrag zwischen Hauptprozess, Oberflächen und Zeitplaner: Einstellungsformat, Zustandsobjekt,
   IPC-Kanäle, Sicherheitsregeln (§7) und die Pflicht-Pause (§11).
2. **`npm test` muss grün sein.** Neue Logik braucht Tests; die Zeitplaner-Tests arbeiten mit
   einer gefälschten Uhr, echte Wartezeiten sind nicht nötig.
3. **Oberflächen visuell prüfen** mit `scripts/dev/preview.js` (Screenshot an den PR anhängen
   hilft sehr).
4. **Sicherheitsregeln einhalten:** kein `innerHTML` mit dynamischen Daten, keine Inline-Skripte
   oder Inline-Styles (die CSP verbietet sie), keine externen Ressourcen, keine neuen
   Netzwerkzugriffe, jeder neue IPC-Kanal wird validiert und pro Fenster freigegeben.
5. **Keine neuen Laufzeit-Abhängigkeiten** ohne guten Grund. Die App kommt bewusst ohne aus.

## Stil

- Einfaches modernes JavaScript. Hauptprozess CommonJS, Oberflächen native ES-Module.
- Kommentare erklären das *Warum*, nicht das *Was*, und sind auf Englisch.
- Sichtbare Texte immer in `strings.js` (Deutsch **und** Englisch, gleiche Schlüssel).

## Was die CI prüft

Pull Requests laufen durch Tests. Installer für alle Systeme entstehen erst beim Setzen eines
Tags `v*` (siehe [docs/PACKAGING.md](docs/PACKAGING.md)).

## Umgangston

Sei freundlich und sachlich. Kritik gilt dem Code, nicht der Person. Wer sich danebenbenimmt,
wird vom Projekt ausgeschlossen.
