# Dokumentation Regelungstechnik 2

Die Hauptdatei ist `main.tex`.

## Bauen

```bash
cd Doku
latexmk -pdf main.tex
```

Falls `latexmk` nicht installiert ist:

```bash
cd Doku
pdflatex main.tex
pdflatex main.tex
```

## Messdaten ersetzen

- `data/sprungantwort.csv`: Sprung der Pumpe und Reaktion von Fuellstand, Durchfluss und Druck.
- `data/stoerung.csv`: Storgroessenversuch mit externem Ablassventil.

Die aktuellen CSV-Dateien sind Platzhalterdaten, damit die Charts in LaTeX bereits funktionieren.
