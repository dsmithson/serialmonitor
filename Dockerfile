# ── Build stage ──────────────────────────────────────────────
# No --platform override: BuildKit runs this stage natively for each target
# platform (via QEMU for arm64). CGO_ENABLED=0 keeps it pure-Go so QEMU
# emulation is the only requirement — no cross-toolchain needed.
FROM golang:1.26-alpine AS builder

WORKDIR /src

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Build (CGO_ENABLED=0 for pure-Go serial library)
COPY . .
RUN CGO_ENABLED=0 \
    go build -ldflags="-s -w" -o /out/serialmonitor ./cmd/serialmonitor

# ── Runtime stage ─────────────────────────────────────────────
FROM alpine:3

# ca-certificates for any future TLS work
RUN apk add --no-cache ca-certificates

# Run as non-root — serial ports typically require dialout group
RUN addgroup -S dialout 2>/dev/null || true \
    && adduser -S -G dialout -s /sbin/nologin serialmonitor

WORKDIR /app
COPY --from=builder /out/serialmonitor .

# Config file mount point — override with a volume/configmap in k8s
RUN mkdir -p /data
VOLUME ["/data"]

USER serialmonitor

EXPOSE 8080

ENTRYPOINT ["/app/serialmonitor"]
CMD ["--config", "/data/config.yaml"]
