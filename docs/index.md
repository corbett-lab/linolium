# ![Linolium](assets/title.png){ .title-img }

Automated phylogenetic lineage proposal and interactive curation.

Linolium provides an environment for lineage discovery and curation on pathogen phylogenetic trees of virtually any size. It builds on the AutoLin algorithm for distance-based identification of clades and provides a UI for customizing the algorithm and curating results.

## Quick Start

```bash
docker run -it --memory=8g -v "$PWD":/data -p 3000:3000 -p 8001:8001 ghcr.io/corbett-lab/lineage-curation
```

Open [http://localhost:3000](http://localhost:3000), upload a `.pb` or `.pb.gz` file, and run the pipeline.

See the [Usage Guide](usage.md) for detailed instructions.
