CLUSTER := scaling-lab
CTX := kind-$(CLUSTER)
KUBECTL := kubectl --context $(CTX)
SCENARIO ?= connections
MODE ?= graceful
KIND_CONFIG ?= k8s/kind.yaml
EDGE_URL ?= http://127.0.0.1:8080
KEDA_IMAGES := ghcr.io/kedacore/keda:2.17.3 ghcr.io/kedacore/keda-metrics-apiserver:2.17.3 ghcr.io/kedacore/keda-admission-webhooks:2.17.3

.PHONY: up app-up monitoring-up prometheus-base-up keda-images metrics-image check open dashboard reset down test test-kind test-kind-smoke hpa-up prometheus-up prometheus-ui grafana-up grafana-ui verify

up: app-up
	@$(MAKE) monitoring-up

app-up:
	@kind get clusters | grep -Fxq '$(CLUSTER)' || kind create cluster --name '$(CLUSTER)' --config '$(KIND_CONFIG)'
	docker build -t scaling-lab-app:local app
	kind load docker-image scaling-lab-app:local --name $(CLUSTER)
	$(KUBECTL) apply -f k8s/app.yaml -f k8s/proxy.yaml
	$(KUBECTL) -n scaling-lab rollout restart deployment/app deployment/edge
	$(KUBECTL) -n scaling-lab rollout status deployment/app --timeout=180s
	$(KUBECTL) -n scaling-lab rollout status deployment/edge --timeout=180s
	@$(MAKE) check

check:
	$(KUBECTL) -n scaling-lab get deployments,pods,services
	curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 1 --retry-max-time 30 --max-time 5 '$(EDGE_URL)/health/ready'

dashboard:
	node dashboard/server.mjs

open:
	python3 -m webbrowser http://127.0.0.1:4173

reset:
	$(KUBECTL) -n scaling-lab delete scaledobject app-prometheus --ignore-not-found
	$(KUBECTL) -n scaling-lab delete hpa app --ignore-not-found
	$(KUBECTL) -n scaling-lab delete hpa keda-hpa-app-prometheus --ignore-not-found
	$(KUBECTL) apply -f k8s/app.yaml -f k8s/proxy.yaml
	$(KUBECTL) -n scaling-lab rollout restart deployment/app
	$(KUBECTL) -n scaling-lab rollout restart deployment/edge
	$(KUBECTL) -n scaling-lab rollout status deployment/app --timeout=180s
	$(KUBECTL) -n scaling-lab rollout status deployment/edge --timeout=180s

hpa-up: metrics-image
	$(KUBECTL) -n scaling-lab delete scaledobject app-prometheus --ignore-not-found
	$(KUBECTL) apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
	$(KUBECTL) -n kube-system patch deployment metrics-server --type=json -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
	$(KUBECTL) -n kube-system rollout status deployment/metrics-server --timeout=180s
	$(KUBECTL) apply -f k8s/hpa.yaml
	@echo 'Wait for kubectl --context $(CTX) -n scaling-lab get hpa app to show a CPU value.'

metrics-image:
	@docker image inspect registry.k8s.io/metrics-server/metrics-server:v0.7.2 >/dev/null 2>&1 || docker pull registry.k8s.io/metrics-server/metrics-server:v0.7.2
	node scripts/load-images.mjs $(CLUSTER) registry.k8s.io/metrics-server/metrics-server:v0.7.2

keda-images:
	@for image in $(KEDA_IMAGES); do docker image inspect "$$image" >/dev/null 2>&1 || docker pull "$$image" || exit $$?; done
	node scripts/load-images.mjs $(CLUSTER) $(KEDA_IMAGES)

prometheus-up: up keda-images
	$(KUBECTL) -n scaling-lab delete hpa app --ignore-not-found
	helm repo add kedacore https://kedacore.github.io/charts --force-update
	helm upgrade --install keda kedacore/keda --version 2.17.3 --namespace keda --create-namespace --kube-context $(CTX) --wait --timeout 5m
	$(KUBECTL) apply -f k8s/prometheus-scaledobject.yaml
	$(KUBECTL) -n scaling-lab get scaledobject,hpa

prometheus-base-up:
	$(KUBECTL) apply -f k8s/prometheus.yaml
	$(KUBECTL) -n scaling-lab rollout status deployment/prometheus --timeout=180s

monitoring-up: grafana-up

prometheus-ui:
	$(KUBECTL) -n scaling-lab port-forward service/prometheus 19090:9090

grafana-up: prometheus-base-up
	$(KUBECTL) apply -f k8s/grafana.yaml
	$(KUBECTL) -n scaling-lab rollout restart deployment/grafana
	$(KUBECTL) -n scaling-lab rollout status deployment/kube-state-metrics --timeout=180s
	$(KUBECTL) -n scaling-lab rollout status deployment/grafana --timeout=180s
	$(KUBECTL) -n scaling-lab rollout status deployment/prometheus --timeout=60s || true
	@echo 'Grafana is local only. Run make grafana-ui, login admin/scaling-lab, open "Scaling Lab · HTTP and pod lifecycle". Compare with the guided timeline: offered RPS, scraped RPS, desired replicas, Ready pods.'

grafana-ui:
	$(KUBECTL) -n scaling-lab port-forward service/grafana 3003:3000

test:
	npm test

test-kind:
	node scripts/kind-test.mjs --full

test-kind-smoke:
	node scripts/kind-test.mjs --smoke

verify:
	node dashboard/verify.mjs $(SCENARIO) $(MODE)

down:
	kind delete cluster --name $(CLUSTER)
