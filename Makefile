CLUSTER := scaling-lab
CTX := kind-$(CLUSTER)
KUBECTL := kubectl --context $(CTX)
SCENARIO ?= connections
MODE ?= graceful

.PHONY: up check open dashboard reset down test hpa-up verify

up:
	@kind get clusters | grep -qx $(CLUSTER) || kind create cluster --config k8s/kind.yaml
	docker build -t scaling-lab-app:local app
	kind load docker-image scaling-lab-app:local --name $(CLUSTER)
	$(KUBECTL) apply -f k8s/app.yaml -f k8s/proxy.yaml
	$(KUBECTL) -n scaling-lab rollout restart deployment/app deployment/edge
	$(KUBECTL) -n scaling-lab rollout status deployment/app --timeout=180s
	$(KUBECTL) -n scaling-lab rollout status deployment/edge --timeout=180s
	@$(MAKE) check

check:
	$(KUBECTL) -n scaling-lab get deployments,pods,services
	curl --fail --silent --show-error http://127.0.0.1:8080/health/ready

dashboard:
	node dashboard/server.mjs

open:
	python3 -m webbrowser http://127.0.0.1:4173

reset:
	$(KUBECTL) -n scaling-lab delete hpa app --ignore-not-found
	$(KUBECTL) apply -f k8s/app.yaml -f k8s/proxy.yaml
	$(KUBECTL) -n scaling-lab rollout restart deployment/app
	$(KUBECTL) -n scaling-lab rollout restart deployment/edge
	$(KUBECTL) -n scaling-lab rollout status deployment/app --timeout=180s
	$(KUBECTL) -n scaling-lab rollout status deployment/edge --timeout=180s

hpa-up:
	$(KUBECTL) apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
	$(KUBECTL) -n kube-system patch deployment metrics-server --type=json -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
	$(KUBECTL) -n kube-system rollout status deployment/metrics-server --timeout=180s
	$(KUBECTL) apply -f k8s/hpa.yaml
	@echo 'Wait for kubectl --context $(CTX) -n scaling-lab get hpa app to show a CPU value.'

test:
	npm test

verify:
	node dashboard/verify.mjs $(SCENARIO) $(MODE)

down:
	kind delete cluster --name $(CLUSTER)
