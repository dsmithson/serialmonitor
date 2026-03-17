# ── Build stage ──────────────────────────────────────────────
# $BUILDPLATFORM = the runner's arch (always amd64 on GitHub Actions).
# Pinning the builder here lets Go cross-compile natively rather than
# emulating the entire build under QEMU, which can take 10–30× longer.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

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
