# Bad Monkey At The Mail Truck

Autonomous AI-powered construction intelligence and lead management platform for Bristlecone Construction's Phoenix/Tucson market expansion.

## What It Does

1. **Daily Intelligence Agent** -- scrapes 20+ AZ construction sources, scores leads via Claude Opus, delivers actionable briefings
2. **Lead Management (Lightweight CRM)** -- tracks projects from first signal through pursuit to outcome
3. **Weekly KPI Export** -- auto-generated pipeline summary in Friday email

## Quick Start

```bash
# Web app
npm install && npm run dev

# Agent
cd agent && npm install && node run.js
```

## Bristlecone Construction -- Client Profile

Source: https://www.bristleconeconstruction.com

| | |
|---|---|
| **Founded** | 2014 |
| **HQ** | Littleton, CO |
| **Expanding to** | Phoenix/Tucson, AZ |
| **Project range** | $500K -- $80M |
| **Type** | Regional GC + Self-Perform Structural Concrete |
| **Leadership** | CEO Zach Smith, President Kevin Strahley, Principal Tom Keilty (AZ) |

### Proven Project Types (45+ completed projects)

The agent uses this portfolio to calibrate lead scoring. Projects similar to Bristlecone's track record score higher.

**Multi-Family (~60% of portfolio -- core strength)**:
Cirrus Apartments, Jeff Park Flats, Townhomes at Cherry Creek North, Asbury Townhomes, Country Club Gardens, Edge LoHi, Art District Flats, Kensington Apartments, Marine Park, The Standard Ft Collins, Diagonal Crossing, Observatory Flats, Eliot Street Center, Cavalier Apartments, Ogden Flats, Aria Apartments, Galapago Townhomes, Aria Townhomes, Art District Lofts

**Hospitality (hotels, restaurants, adaptive reuse)**:
Courtyard Mile High, Catbird Hotel, AC Hotel RiNo, Warwick Hotel, SW Denver YMCA Renovation, Jacques French Restaurant, 4541 Navajo

**Commercial / Mixed-Use**:
Market Street Center, Edgewater Public Market, Pearl Market + Wine, Littleton Mixed Use, BCC Office and Alley, Columbine Knolls Clubhouse

**Institutional / Public**:
Founders Park, Harvard Square Memory Care, Kobold

**Retail**:
God Save the Cream, Casa Bianca Bridal

### Scoring Implications (one factor among many -- Tom's judgment is final)

- Multifamily in Phoenix metro = score generously (proven #1 project type)
- Hospitality / boutique hotel = strong fit (deep track record)
- Mixed-use urban infill = strong fit
- Memory care / senior living = possible fit (proven with Harvard Square)
- Design-forward / complex projects = Bristlecone's differentiator vs commodity builders
- $2M minimum for GC scope, $1M minimum for concrete scope
- $5M--$40M range = sweet spot based on portfolio

### Services

- **Pre-Construction**: Cost feedback, value engineering, constructability reviews, BIM coordination
- **Construction**: Full project staffing, procurement, safety, scheduling
- **Post-Construction**: Building Care Program (warranty/maintenance)
- **Self-Perform**: Structural concrete division

### Delivery Methods

- Preferred: Negotiated, Design-Build, CM-at-Risk
- Selective: Hard-bid over ~$2M for GC scope
- Concrete: Hard-bid structural concrete -- all sizes $1M+

## Architecture

See [CLAUDE.md](../CLAUDE.md) for full technical architecture, environment variables, and development commands.
