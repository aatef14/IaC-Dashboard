# IaC-Dashboard runs Terraform + the Azure CLI, so both need to actually be
# on PATH in the image, not just the Python app itself.
#
# Two things this app normally does on Windows can't work in a container,
# and fail with a clear message instead (see run_manager.py):
#   - the native "Browse..." folder picker (WinForms) -- type the project
#     path directly (e.g. under a volume you mounted).
#   - the "Restart Server" button (spawns stop.ps1/start.ps1) -- restart the
#     container instead: `docker compose restart`.
FROM python:3.12-slim

ARG TERRAFORM_VERSION=1.9.8

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg unzip \
    && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
    && curl -sLo /tmp/terraform.zip \
         "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
    && unzip -o /tmp/terraform.zip -d /usr/local/bin \
    && rm -rf /tmp/terraform.zip /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py run_manager.py run_store.py ./
COPY static/ ./static/

# 0.0.0.0, not 127.0.0.1 -- binding to loopback INSIDE a container makes it
# unreachable from outside the container (a very common gotcha), even with
# a published port. docker-compose.yml re-establishes "never reachable off
# this machine" by publishing as 127.0.0.1:8765:8765, not a bare 8765:8765.
ENV IAC_DASHBOARD_HOST=0.0.0.0
ENV IAC_DASHBOARD_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8765
CMD ["python", "server.py"]
