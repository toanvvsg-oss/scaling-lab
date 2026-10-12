# GKE Standard node-pool continuation (lessons 13/14 cloud steps).
#
# CLOUD EXECUTION IS PENDING EXPLICIT CONFIGURATION. GKE node pools are NOT
# kubectl-applied manifests: create them with gcloud against YOUR project and
# tear them down afterwards. Required: GKE_PROJECT, GKE_REGION, GKE_CLUSTER.
# Local validation only checks this file's presence and the script's guards.
#
# 1. Autoscaling pool for the schedulable scale-up (lesson 13):
#
#   gcloud container node-pools create scaling-lab-pool \
#     --project="${GKE_PROJECT:?explicit project required}" \
#     --region="${GKE_REGION:?explicit region required}" \
#     --cluster="${GKE_CLUSTER:?explicit cluster required}" \
#     --machine-type=e2-medium --num-nodes=1 \
#     --enable-autoscaling --min-nodes=1 --max-nodes=3
#
# 2. Diagnose autoscaler decisions (do NOT use a current/default context):
#
#   kubectl --context "${GKE_CONTEXT:?explicit context required}" \
#     -n kube-system logs deployment/cluster-autoscaler --tail=200
#   kubectl --context "${GKE_CONTEXT}" get events --all-namespaces \
#     --field-selector reason=TriggeredScaleUp,reason=NotTriggerScaleUp
#
# 3. Teardown (pools bill until deleted):
#
#   gcloud container node-pools delete scaling-lab-pool \
#     --project="${GKE_PROJECT}" --region="${GKE_REGION}" \
#     --cluster="${GKE_CLUSTER}" --quiet
