# webrobot_simulator — Simulateur VWAP + EMA 9/20 + CBC

Page web statique (JavaScript pur, aucun backend) qui simule une stratégie
de trading **en temps réel** avec un capital **fictif de 10 000 €**.

> **Ceci n'est pas un conseil de trading, mais un test pédagogique de
> construction d'interface. L'utilisation de cette interface ne saurait
> constituer la moindre responsabilité lors d'une utilisation de trading réel.**

## Principe

1. L'utilisateur saisit **un seul symbole** Binance (ex. `BTCUSDT`).
2. Le symbole est vérifié sur l'API publique Binance ; s'il n'existe pas →
   message **« non disponible »**, aucune session n'est ouverte.
3. 200 bougies 1 min sont chargées pour amorcer les indicateurs.
   La dernière ligne étant la bougie **en cours**, elle est mise de côté
   (jamais utilisée pour décider : règle CBC sur bougies clôturées).
4. **Warm start + décision immédiate** : les règles sont rejouées sur
   l'historique pour reconstruire l'état (tendance, repli armé) **sans**
   générer de trade sur le passé ; la dernière bougie clôturée est alors
   évaluée tout de suite. La décision s'affiche au lancement
   (« repli armé » / « pas de repli », signal éventuel entré au prix live).
5. Le flux WebSocket temps réel démarre :
   - `kline_1m` → décision **uniquement à la clôture** de chaque bougie,
   - `aggTrade` → suivi tick par tick du prix et des stop/target.
6. Fermer ou recharger la page **efface tout** : ni cookies, ni
   localStorage, ni base de données. Chaque connexion = session à zéro.

## Règles de la stratégie (hypothèses de départ, non validées)

| Composant | Règle codée |
|---|---|
| Tendance | EMA 9 > EMA 20 (LONG) / EMA 9 < EMA 20 (SHORT) |
| Filtre de prix | Prix > VWAP session UTC (LONG) / < (SHORT) |
| Repli | Prix revient toucher le nuage EMA 9/20 (« armement »), expire après 6 bougies |
| Déclencheur CBC | *Candle By Candle* : clôture > plus haut de la bougie précédente (LONG), clôture < plus bas (SHORT) |
| Entrée | À la clôture de la bougie de confirmation + slippage |
| Stop-loss | Creux/creta des 5 dernières bougies − 0.5 × ATR(14) |
| Take-profit | Prochain pivot (R1/S1), sinon 2R |
| Sortie supplémentaire | Croisement inverse EMA 9/20 (invalidation de tendance) |

## Hypothèses financières (valeurs par défaut, modifiables dans `broker.js`)

| Paramètre | Valeur | Origine |
|---|---|---|
| Capital initial | 10 000 € | Choix utilisateur (fictif) |
| Risque par trade | 0.5 % du capital | Hypothèse de gestion de risque |
| Coûts par trade | 0.08 R | Hypothèse (commission + slippage non mesurés) |
| Slippage d'exécution | 0.05 % du prix | Hypothèse |
| Levier | Aucun (position ≤ capital) | Choix de conception |

Aucune de ces valeurs ne constitue un résultat de backtest.

## Sources (toutes gratuites, sans clé API)

- **Prix temps réel** : WebSocket public Binance —
  `wss://data-stream.binance.vision` (repli `wss://stream.binance.com:9443`)
  documenté sur https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
- **Historique et vérification de symbole** : REST public Binance —
  `https://data-api.binance.vision/api/v3` (repli `https://api.binance.com/api/v3`)
  — endpoints `klines` et `ticker/price`
  (https://developers.binance.com/docs/binance-spot-api-docs/rest-api)
- **Graphique** : widget officiel TradingView *Advanced Chart* (embed gratuit)
  https://www.tradingview.com/widgethub/ — TradingView ne fournit pas de
  flux programmatique, il sert uniquement à l'affichage ; le moteur
  recalcule VWAP/EMA/CBC lui-même sur les prix Binance.
- **Formules** : EMA, VWAP, ATR(14), pivots floor-trader — définitions
  standard de l'analyse technique.

## Déploiement (coût : 0 €)

```bash
cd webrobot_simulator
git init
git add .
git commit -m "Simulateur VWAP + EMA 9/20 + CBC"
# créer un dépôt sur GitHub puis :
git remote add origin https://github.com/<toi>/<repo>.git
git push -u origin main
```

Netlify → *Add new site* → *Import an existing project* → choisir le dépôt →
build vide, publish directory `.` (le `netlify.toml` fourni suffit).

## Test local

Ouvrir `index.html` dans un navigateur, ou servir en local :

```bash
python -m http.server 8080
# puis http://localhost:8080
```

## Limites assumées

- Résultats **100 % fictifs**, aucun ordre réel, aucun compte requis.
- Frais/slippage forfaitaires : pas de simulation de carnet d'ordres.
- VWAP recalculé sur la session UTC à partir des 200 bougies disponibles
  (si la session a commencé plus tôt, le VWAP est approché).
- **Aucune rentabilité n'est démontrée** : pas de backtest, pas de
  validation walk-forward. Une courte session produit peu de trades
  (bougies de 1 min, signaux rares).
- Code source public (site statique) : aucun secret dedans.

## Structure

```
webrobot_simulator/
├── index.html        page unique (formulaire, chart, panneau, mention)
├── css/style.css     thème sombre
├── js/
│   ├── indicators.js VWAP, EMA 9/20, ATR(14), pivots (+ snapshots par bougie)
│   ├── strategy.js   règles LONG/SHORT (bougies clôturées uniquement) + warm start
│   ├── broker.js     portefeuille 10 000 €, SL/TP, frais, statistiques
│   ├── feed.js       WebSocket Binance + REST (validation, historique)
│   ├── ui.js         rendu + widget TradingView
│   ├── chart.js      graphe « vue du robot » (canvas : bougies, EMA, VWAP, trades)
│   └── main.js       cycle de vie de la session (état en mémoire)
├── netlify.toml      publication Netlify (statique)
└── README.md         ce fichier
```
