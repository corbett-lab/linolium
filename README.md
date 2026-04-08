## Linolium

Automated phylogenetic lineage proposal and interactive curation.

This tool provides an interactive environment for lineage discovery and curation on pathogen phylogenetic trees of virtually any size. It builds upon the original AutoLin algorithm for distance based identification of clades and provides an environment for customizing the algorithm to weight certain phenotypes more heavily in consideration of lineage designation. For more information on the AutoLin algorithm see ./autolin/README.md.

## Usage
**Input**: UShER MAT protobuf file (`.pb` or `.pb.gz`)  
**Output**: Proposed sub-lineages + interactive curation UI

#### Quick Start

```bash
docker run -it -v "$PWD":/data -p 3000:3000 -p 8001:8001 ghcr.io/corbett-lab/lineage-curation
```

Then open http://localhost:3000, upload a .pb (or .pb.gz) file, configure parameters, and run the pipeline. Results can be downloaded as .jsonl.gz, .pb.gz, or .tsv from the UI.

Or build locally:

```bash
docker build -t lineage-curation .
docker run -it -v "$PWD":/data -p 3000:3000 -p 8001:8001 lineage-curation
```

Open http://localhost:3000, upload a `.pb` (or `.pb.gz`) file, configure parameters, and run the pipeline. Results can be downloaded as `.jsonl.gz`, `.pb.gz`, or `.tsv` from the UI.

#### Advanced: Manual Pipeline

To run the individual steps manually inside the container:

```bash
docker run -it -v "$PWD":/data -p 3000:3000 -p 8001:8001 lineage-curation bash
```

```bash
# Propose lineages on an input tree
python /app/autolin/propose_sublineages.py -i /data/input.pb -o /data/output.autolin.pb \
  -m 10 -t 1 -u 0.95 -r

# Convert annotated tree to Taxonium format (creates output.autolin.jsonl.gz)
python /app/autolin/convert_autolinpb_totax.py -a /data/output.autolin.pb

# Generate sample-to-lineage TSV (cd / needed for matUtils path handling)
cd / && matUtils summary -i /data/output.autolin.pb -C /data/output.autolin.tsv

# Launch the curation UI with a pre-built jsonl.gz
cd /app/ui/taxonium_backend && node server.js --port 8001 --data_file /data/output.autolin.jsonl.gz &
cd /app/ui && npx vite preview --port 3000 --host 0.0.0.0
```

See `python /app/autolin/propose_sublineages.py --help` for all parameter options.

### Components

- **[autolin/](autolin/)** - Autolin algorithm for lineage proposals
- **[ui/](ui/)** - Web interface for curation
- **[recombination-detection/](recombination-detection/)** - Recombination analysis

### Development

For faster iteration without rebuilding the image:

```bash
./dev.sh
```

This mounts source files into the container and uses vite's dev server with hot reload.
