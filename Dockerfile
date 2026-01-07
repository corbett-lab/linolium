FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates wget tzdata bzip2 git \
    build-essential gcc g++ \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Miniconda (auto-detect architecture)
ENV CONDA_DIR=/opt/conda
ENV PATH=$CONDA_DIR/bin:$PATH

RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-aarch64.sh"; \
    else \
        URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh"; \
    fi && \
    wget --quiet "$URL" -O /tmp/miniconda.sh && \
    bash /tmp/miniconda.sh -b -p $CONDA_DIR && \
    rm /tmp/miniconda.sh && conda clean -afy

# Configure Conda
RUN conda config --system --add channels conda-forge && \
    conda config --system --set channel_priority strict && \
    conda config --system --set always_yes yes
RUN conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main || true
RUN conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r || true
RUN conda install -n base mamba

# Create Python environment
WORKDIR /workspace
COPY env.yml /workspace/env.yml
RUN conda env create -f env.yml && conda clean -afy
RUN mamba run -n taxalin mamba install -c conda-forge boost=1.85 -y


# Copy Python tools
COPY autolin /workspace/autolin
COPY data /workspace/data

# Build UI (in /workspace so it's separate from mounted /workspace)
COPY ui/linolium /workspace/ui
WORKDIR /workspace/ui
RUN npm run install-all && NODE_OPTIONS="--max-old-space-size=8192" npm run build


WORKDIR /workspace
EXPOSE 3000 8001

# Setup shell
RUN conda init bash && echo "conda activate taxalin" >> /root/.bashrc
SHELL ["/bin/bash", "-c"]