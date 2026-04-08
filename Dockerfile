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

# Create Python environment (only rebuilds when env.yml changes)
WORKDIR /app
COPY env.yml /app/env.yml
RUN conda env create -f env.yml && conda clean -afy

# Install Node deps (only rebuilds when package*.json change)
WORKDIR /app/ui
COPY ui/linolium/package.json ui/linolium/package-lock.json ./
COPY ui/linolium/taxonium_component/package.json ./taxonium_component/
COPY ui/linolium/taxonium_data_handling/package.json ./taxonium_data_handling/
COPY ui/linolium/taxonium_backend/package.json ./taxonium_backend/
RUN npm install && \
    cd taxonium_component && npm install && \
    cd ../taxonium_data_handling && npm install && \
    cd ../taxonium_backend && npm install

# Copy source and build UI (rebuilds on any source change, but deps are cached)
COPY ui/linolium /app/ui
RUN NODE_OPTIONS="--max-old-space-size=8192" npm run build

# Copy Python tools and data
WORKDIR /app
COPY autolin /app/autolin
COPY data /app/data

RUN mkdir -p /data
EXPOSE 3000 8001

# Setup shell
RUN conda init bash && echo "conda activate taxalin" >> /root/.bashrc
SHELL ["/bin/bash", "-c"]

# Set Node.js memory limit for large trees
ENV NODE_OPTIONS="--max-old-space-size=8192"

# Create start script for the launcher workflow
RUN printf '#!/bin/bash\n\
source /opt/conda/etc/profile.d/conda.sh\n\
conda activate taxalin\n\
\n\
echo ""\n\
echo "🧬 Lineage Curation Launcher"\n\
echo ""\n\
\n\
# Start backend server in launcher mode (no data file)\n\
cd /app/ui/taxonium_backend\n\
echo "🔌 Starting backend on port 8001..."\n\
node server.js --port 8001 &\n\
BACKEND_PID=$!\n\
\n\
# Wait for backend to initialize\n\
sleep 2\n\
\n\
# Start frontend server\n\
cd /app/ui\n\
echo "🌐 Starting frontend on port 3000..."\n\
npx vite preview --port 3000 --host 0.0.0.0 &\n\
FRONTEND_PID=$!\n\
\n\
echo ""\n\
echo "✨ Ready!"\n\
echo "🌐 Open http://localhost:3000 in your browser"\n\
echo "📂 Upload a .pb file to begin"\n\
echo ""\n\
\n\
# Wait for either process to exit\n\
wait\n\
' > /opt/start.sh && chmod +x /opt/start.sh

CMD ["/opt/start.sh"]
