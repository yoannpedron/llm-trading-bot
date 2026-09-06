# Démo autonome (page unique)

`build-demo.py` enrichit un sous-ensemble du catalogue via TMDB, compresse les images en WebP (data URI) et produit `demo-data.json`. Le JSON est injecté à la place de `__DATA__` dans `lumen-template.html` pour obtenir une page HTML unique sans réseau, publiable telle quelle (< 16 Mo).

```bash
TMDB_API_KEY=... python3 build-demo.py   # attend selection.json (sortie du parseur, voir src/parser)
```
