#!/usr/bin/env bash
# GCE startup script for the egress proxy VM. Installs tinyproxy and writes the
# same allow-list config the local compose stack uses, pulled from instance
# metadata (tinyproxy-conf, proxy-filter) so the VM stays reproducible.
set -euo pipefail

apt-get update -y
apt-get install -y tinyproxy

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
curl -s -H "Metadata-Flavor: Google" "$META/tinyproxy-conf" > /etc/tinyproxy/tinyproxy.conf
curl -s -H "Metadata-Flavor: Google" "$META/proxy-filter" > /etc/tinyproxy/proxy-filter.txt

systemctl enable tinyproxy
systemctl restart tinyproxy
