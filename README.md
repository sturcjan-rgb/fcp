# FC Písek TV

Klubová videoplatforma **FC Písek** — přebaluje veřejné přenosy
z [tvcom.cz](https://www.tvcom.cz) (3. ČFL A) do vlastního designu a filtruje
jen zápasy Písku. Žádný vlastní streaming, jen automatizované vkládání
oficiálního přehrávače s uvedením zdroje. Data i videa se aktualizují sama,
bez ručních kroků.

## Jak to funguje

```
tvcom.cz (rozpis + embed přehrávače 3. ČFL A)
        │
        ▼
scraper.mjs  ── běží automaticky přes GitHub Actions (cron každé 2 h)
        │
        ▼
data/matches.json  ── scraper sem SLUČUJE výsledek, nikdy ho nepřepisuje celý
        │
        ▼
index.html  ── web si matches.json načte přes fetch() a zobrazí v designu FC Písek
        │
        ▼
GitHub Pages  ── hosting zdarma, automatický deploy při každém commitu
```

Žádný backend, žádná databáze. Celý „server" jsou statické soubory na GitHub
Pages plus jeden scheduled job, který jednou za čas přepíše jeden JSON soubor.

## Soubory

```
├── index.html                 # celá stránka v jednom souboru (logo i font zapečené jako base64)
├── scraper.mjs                # scraper (Node.js + cheerio)
├── package.json               # jediná závislost: cheerio
├── data/
│   └── matches.json           # výstup scraperu — zápasy + embed GUID
└── .github/workflows/
    └── scrape.yml             # kdy a jak se scraper spouští
```

## Co je ověřeno pro tenhle klub

- **Soutěž na tvcomu:** `Soutez-Fortuna-CFL-A` (zobrazuje se jako „3. ČFL A",
  tj. 3. Česká fotbalová liga, skupina A).
- **Tým:** v ČFL A hraje jen A-tým „**FC Písek**", takže scraper filtruje podle
  `"Písek"` v názvu (mládežnická „Sršni Písek" apod. jsou v jiných soutěžích,
  do výběru se nepletou).
- **Stránka je server-renderovaná** — stačí `fetch()` + `cheerio`, žádný
  headless prohlížeč.
- **Embed přehrávače:** `//embed.tvcom.cz/{GUID}/`, v HTML detailu zápasu; bývá
  předpřipravený i u budoucích zápasů.
- **Číslo kola** (např. „2. kolo") v rozpisu není — scraper ho dopočte z detailu
  zápasu (je v titulku sdílení, „… 3. ČFL A, 2. kolo"). Než se dopočte, drží se
  fallback „3. ČFL A".
- **Přepínač sezón na tvcomu:** `…/Sezona-RRRR-RRRR/` — scraper prochází
  aktuální + (dle nastavení) minulé sezóny a slučuje, aby při přechodu na novou
  sezónu nezmizela historie. Fotbalová sezóna běží červenec–červen.

## Výchozí data (seed)

`data/matches.json` obsahuje reálný startovní vzorek zápasů Písku ze sezóny
2026/2027 (přímo z výpisu tvcom.cz). Zatím má vyřešené jen jedno video
(úvod 16. 8. 2026 vs FK Loko Praha) — **zbytek embedů, čísla kol i kompletní
rozpis doplní scraper sám při prvním běhu.** Seed slouží jen k tomu, aby web
nebyl při prvním otevření prázdný; po prvním běhu Actions ho scraper rozšíří
a udržuje aktuální. Pro doplnění minulé sezóny 2025/2026 spusťte workflow ručně
s `seasons_back = 1` (nebo víc pro starší historii).

## Nasazení na GitHub Pages

1. **Založit repozitář** a nahrát soubory. Soubor `.github/workflows/scrape.yml`
   nahrávejte přes **Add file → Create new file** a do názvu vložte **celou
   cestu** `.github/workflows/scrape.yml` (drag&drop upload skryté složky
   s tečkou běžně tiše přeskočí).
2. **Settings → Actions → General → Workflow permissions** → zaškrtnout
   **„Read and write permissions"** (jinak scraper data stáhne, ale nedokáže
   je commitnout zpět).
3. **Settings → Pages** → Source: **Deploy from a branch** → `main` → `/(root)`.
   Když se Pages po uložení nepostaví, přepněte Source pryč a zpátky.
4. **Actions → „Aktualizace zápasů FC Písek TV" → Run workflow** — první ruční
   spuštění, ať se data hned naplní. Pro jednorázový hlubší backfill historie
   zadejte do pole `seasons_back` vyšší číslo (např. `3`).
5. Volitelně **vlastní doména** (např. `tv.fcpisek.cz`) — Settings → Pages
   → Custom domain + CNAME záznam u správce DNS mířící na `{username}.github.io`.

> Web běží přes `fetch('data/matches.json')`, což **nefunguje přes `file://`** —
> stránku otevřenou dvojklikem lokálně nic nenačte. Potřebuje HTTP server
> (GitHub Pages, nebo lokálně `python3 -m http.server`).

## Než se pustí naostro k veřejnosti

Re-embedování cizího přehrávače je obvykle v pořádku (jde o jejich oficiální
player, stejný obsah, s otevřeným uvedením zdroje), ale je to jejich
infrastruktura a obsah — **předem kontaktujte tvcom.cz**, popište záměr a jak
je zdroj uvedený, a počkejte na odpověď. Produkční verzi klidně stavte
paralelně, jen ji nezveřejňujte, dokud nepřijde souhlas.

## Výměna assetů / úprava vzhledu

- **Barvy a velikosti** jsou v `:root{…}` na začátku `<style>` jako CSS
  proměnné (`--blue`, `--gold`, `--fs-teams`, …) — stačí přepsat hodnoty.
  Značková modrá Písku je `#223080`, žlutá `#FCC400`.
- **Logo** je v hlavičce jako `<img src="data:image/png;base64,…">`
  (oficiální PNG). Až bude k dispozici vektorové **SVG** loga, jde `<img>`
  nahradit inline `<svg>` (pozor na kolize CSS tříd, pokud vkládáte víc SVG —
  třídy si opatřete unikátním prefixem).
- **Font nadpisů:** klubový **CHANEY** je zapečený přes `@font-face`
  (WOFF2 v base64) — `font-family:"Chaney"` pro nadpisy, `"Chaney Extended"`
  pro wordmark v hlavičce. Jako fallback slouží „Barlow Condensed" (Google
  Fonts). Chceš-li font vyměnit, přepiš base64 v `@font-face` a `font-family`.
