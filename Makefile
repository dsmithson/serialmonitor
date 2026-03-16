BINARY      := serialmonitor
CMD         := ./cmd/serialmonitor
IMAGE       := dockerhub-username/serialmonitor
TAG         := latest
PLATFORMS   := linux/amd64,linux/arm64

.PHONY: build run test docker-build docker-push helm-lint

build:
	CGO_ENABLED=0 go build -ldflags="-s -w" -o $(BINARY) $(CMD)

run: build
	./$(BINARY) --config config.yaml

test:
	go test ./...

# Multi-arch image build (requires docker buildx)
docker-build:
	docker buildx build \
		--platform $(PLATFORMS) \
		-t $(IMAGE):$(TAG) \
		--push \
		.

# Push single-arch local image
docker-push:
	docker push $(IMAGE):$(TAG)

helm-lint:
	helm lint helm/serialmonitor

helm-install:
	helm upgrade --install serialmonitor helm/serialmonitor \
		--set image.repository=$(IMAGE) \
		--set image.tag=$(TAG)
