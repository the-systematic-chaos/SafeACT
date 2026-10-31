# Job image for the workflows in .github/workflows. It does not contain lfc: each workflow installs
# the lfc it tests into the job (lf-pr.yml downloads the one its build-lfc job built). The image only
# carries what that lfc and the program need: Java for lfc, a C toolchain with CMake and the Python
# headers for the Python target, and the program's Python packages.
FROM eclipse-temurin:21-jre-noble

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        cmake gcc libc6-dev make procps \
        python3-dev python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages numpy websockets "trossen_arm==1.9.*"
