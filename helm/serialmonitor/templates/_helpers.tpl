{{- define "serialmonitor.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "serialmonitor.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{ include "serialmonitor.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "serialmonitor.selectorLabels" -}}
app.kubernetes.io/name: serialmonitor
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
