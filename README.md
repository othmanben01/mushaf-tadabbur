# مصحف التدبر · Mushaf Tadabbur

Application web simple pour **lire le Coran** (texte arabe en rasm uthmani) et **comprendre chaque verset** grâce au tafsir.

## Fonctionnalités

- Les 114 sourates en écriture uthmani
- Deux modes de lecture : **verset par verset** ou **pages du Mushaf** (604 pages du Mushaf de Médine, avec juz', hizb et quarts de hizb ; glisser du doigt pour tourner les pages)
- Tafsir sous chaque verset : **Al-Muyassar** (par défaut), **As-Sa'di**, **Ibn Kathir**
- Récitation verset par verset avec enchaînement automatique et choix du récitateur : **Saad Al-Ghamdi, Maher Al-Muaiqly, Abdul Basit, Al-Husary, Yasser Ad-Dossari, As-Sudais**
- **توقفت هنا** : marque le verset où tu t'es arrêté (un seul à la fois)
- Marque-pages multiples (**علامة**)
- Recherche par mot ou par référence (ex. `2:255`)
- Mode nuit et taille du texte réglable

Tout est enregistré dans le navigateur (localStorage). Aucun compte, aucun serveur.

## Utilisation

Ouvre l'adresse GitHub Pages du projet. Sur téléphone, ajoute-la à l'écran d'accueil pour l'utiliser comme une application.

## Structure

| Dossier / fichier | Contenu |
|---|---|
| `index.html` | L'application complète (HTML, CSS, JavaScript) |
| `s/` | Texte arabe de chaque sourate |
| `tm/` | Tafsir Al-Muyassar |
| `ts/` | Tafsir As-Sa'di |
| `tk/` | Tafsir Ibn Kathir |
| `quran.json` | Texte complet, utilisé pour la recherche |

## Sources

- Texte uthmani : [The Noble Qur'an Encyclopedia](https://quranenc.com), via le paquet npm `quran-json`
- Tafsirs : [spa5k/tafsir_api](https://github.com/spa5k/tafsir_api)
- Pages, juz' et hizb : paquet npm [`quran-meta`](https://www.npmjs.com/package/quran-meta)
- Police : Amiri Quran (licence SIL OFL, voir `fonts/`)
- Audio : [EveryAyah.com](https://everyayah.com) (fichiers verset par verset)
