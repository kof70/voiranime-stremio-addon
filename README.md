# Voiranime Stremio Addon (Perso)

Addon Stremio (catalogue + metadata + streams) basé sur le scraping de [v6.voiranime.com](https://v6.voiranime.com/) et le SDK officiel.

## Prérequis

- Node.js >= 18

## Lancer en local

```bash
npm install
npm start
```

Le manifest sera disponible ici :

```
http://localhost:8000/manifest.json
```

Dans Stremio : **Addons** → **Community Addons** → coller l’URL du manifest.

## Catalogues

- **Voiranime - En cours** : animes en cours de diffusion (liste paginée).
- **Voiranime - Nouveaux ajouts** : derniers animes ajoutés.
- **Voiranime - Recherche** : recherche par titre.

## Notes importantes

- Usage personnel uniquement. Vérifie que tu as le droit d’accéder aux contenus.
- Le resolveur Vidmoly tente d’extraire une URL directe (mp4/m3u8). En fallback, `externalUrl` ouvre le lecteur dans le navigateur.
- Le scraping peut casser si le site change sa structure.

## Structure

- `server.js` : serveur HTTP + scraping
- `package.json` : scripts et dépendances

## Débogage rapide

- `/catalog/series/voiranime-ongoing.json` — En cours
- `/catalog/series/voiranime-recent.json` — Nouveaux ajouts
- `/catalog/series/voiranime-search.json?search=oshi+no+ko` — Recherche
- `/meta/series/voiranime:the-case-book-of-arne.json` — Fiche anime
- `/stream/series/voiranime:the-case-book-of-arne:the-case-book-of-arne-05-vostfr.json` — Lecteurs

## Pagination

Stremio envoie `skip` dans le catalogue. L’addon mappe `skip` sur les pages du site (pages de 10 éléments).
