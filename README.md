# Lineage Curation

Automated phylogenetic lineage proposal and interactive curation.

This tool provides an interactive environment for lineage discovery and curation on pathogen phylogenetic trees of virtually any size. It builds upon the original AutoLin algorithm for distance based identification of clades and provides an environment for customizing the algorithm to weight certain phenotypes more heavily in consideration of lineage designation. For more information on the AutoLin algorithm see ./autolin/README.md.

## Usage
**Input**: UShER MAT protobuf file (`.pb` or `.pb.gz`)  
**Output**: Proposed sub-lineages + interactive curation UI

## Quick Start

```bash
docker build -t lineage-curation .
docker run -it -v "$PWD":/data -p 3000:3000 -p 8001:8001 lineage-curation
```

Open http://localhost:3000, upload a `.pb` (or `.pb.gz`) file, configure parameters, and run the pipeline. Results can be downloaded as `.jsonl.gz`, `.pb.gz`, or `.tsv` from the UI.

## Development

For faster iteration without rebuilding the image:

```bash
./dev.sh
```

This mounts source files into the container and uses vite's dev server with hot reload.

## Components

- **[autolin/](autolin/)** - Autolin algorithm for lineage proposals
- **[ui/](ui/)** - Web interface for curation
- **[recombination-detection/](recombination-detection/)** - Recombination analysis
