# ── Build stage ──────────────────────────────────────────────
FROM golang:1.22-bookworm AS builder

WORKDIR /src

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Build (CGO_ENABLED=0 for pure-Go serial library)
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w" -o /out/serialmonitor ./cmd/serialmonitor

# ── Runtime stage ─────────────────────────────────────────────
FROM debian:bookworm-slim

# ca-certificates for any future TLS work
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run as non-root — serial ports typically require dialout group
RUN groupadd -r dialout 2>/dev/null || true \
    && useradd -r -g dialout -s /sbin/nologin serialmonitor

WORKDIR /app
COPY --from=builder /out/serialmonitor .

# Config file mount point — override with a volume/configmap in k8s
RUN mkdir -p /data
VOLUME ["/data"]

USER serialmonitor

EXPOSE 8080

ENTRYPOINT ["/app/serialmonitor"]
CMD ["--config", "/data/config.yaml"]
