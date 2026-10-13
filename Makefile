CLUSTER := scaling-lab
CTX := kind-$(CLUSTER)
KUBECTL := kubectl --context $(CTX)
SCENARIO ?= connections
MODE ?= graceful

.PHONY: up check open dashboard ui-build ui-dev reset down test hpa-up prometheus-up prometheus-ui grafana-up grafana-ui verify

up:
	@clusters="$$(kind get clusters 2>&1)" || { echo "$$clusters"; exit 1; }; \
	echo "$$clusters" | grep -qx $(CLUSTER) || kind create cluster --config k8s/kind.yaml
	docker build -t scaling-lab-app:local app
	kind load docker-image scaling-lab-app:local --name $(CLUSTER)
	$(KUBECTL) apply -f k8s/app.yaml -f k8s/proxy.yaml
	$(KUBECTL) -n scaling-lab rollout restart deployment/app deployment/edge
	$(KUBECTL) -n scaling-lab rollout status deployment/app --timeout=180s
	$(KUBECTL) -n scaling-lab rollout status deployment/edge --timeout=180s
	@$(MAKE) check

check:
	$(KUBECTL) -n scaling-lab get deployments,pods,services
	@for i in 1 2 3 4 5 6; do \
	  if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 http://127.0.0.1:8080/health/ready; then \
	    echo; break; \
	  fi; \
	  if [ $$i -eq 6 ]; then echo 'edge readiness did not succeed within ~60s (6 tries, 5s curl cap + 5s sleep)'; exit 1; fi; \
	  sleep 5; \
	done

dashboard:
	node dashboard/server.mjs

ui-build:
	npm --prefix dashboard/ui install
	npm --prefix dashboard/ui run build

ui-dev:
	npm --prefix dashboard/ui run dev

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

hpa-up:
	$(KUBECTL) -n scaling-lab delete scaledobject app-prometheus --ignore-not-found
	$(KUBECTL) apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.0/components.yaml
	$(KUBECTL) -n kube-system patch deployment metrics-server --type=json -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
	$(KUBECTL) -n kube-system rollout status deployment/metrics-server --timeout=180s
	$(KUBECTL) apply -f k8s/hpa.yaml
	@echo 'Wait for kubectl --context $(CTX) -n scaling-lab get hpa app to show a CPU value.'

prometheus-up: up
	$(KUBECTL) -n scaling-lab delete hpa app --ignore-not-found
	$(KUBECTL) apply -f k8s/prometheus.yaml
	$(KUBECTL) -n scaling-lab rollout status deployment/prometheus --timeout=180s
	helm repo add kedacore https://kedacore.github.io/charts --force-update
	helm upgrade --install keda kedacore/keda --version 2.21.0 --namespace keda --create-namespace --kube-context $(CTX) --wait --timeout 5m
	$(KUBECTL) apply -f k8s/prometheus-scaledobject.yaml
	$(KUBECTL) -n scaling-lab get scaledobject,hpa

prometheus-ui:
	$(KUBECTL) -n scaling-lab port-forward service/prometheus 19090:9090

grafana-up:
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

verify:
	node dashboard/verify.mjs $(SCENARIO) $(MODE)

down:
	kind delete cluster --name $(CLUSTER)
