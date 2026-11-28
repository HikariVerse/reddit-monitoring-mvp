FROM python:3.12-slim
WORKDIR /opt/r4
COPY pyproject.toml ./
COPY zst_archive ./zst_archive
COPY analytics_core ./analytics_core
ARG INSTALL_ANALYTICS=false
ARG INSTALL_BALANCED=false
ARG PIP_INDEX_URL=""
RUN if [ -n "$PIP_INDEX_URL" ]; then INDEX_FLAG="-i $PIP_INDEX_URL"; else INDEX_FLAG=""; fi && \
    if [ "$INSTALL_ANALYTICS" = "true" ] && [ "$INSTALL_BALANCED" = "true" ]; then \
      pip install --no-cache-dir --default-timeout=120 --retries 5 $INDEX_FLAG ".[analytics,balanced]" && \
      pip install --no-cache-dir --default-timeout=120 --retries 5 $INDEX_FLAG "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"; \
    elif [ "$INSTALL_ANALYTICS" = "true" ]; then \
      pip install --no-cache-dir --default-timeout=120 --retries 5 $INDEX_FLAG ".[analytics]"; \
    else \
      pip install --no-cache-dir --default-timeout=120 --retries 5 $INDEX_FLAG .; \
    fi
ARG INSTALL_GPU=false
RUN if [ "$INSTALL_GPU" = "true" ]; then \
      if [ -n "$PIP_INDEX_URL" ]; then INDEX_FLAG="-i $PIP_INDEX_URL"; else INDEX_FLAG=""; fi; \
      pip uninstall -y onnxruntime || true; \
      pip install --no-cache-dir --default-timeout=120 --retries 5 $INDEX_FLAG ".[gpu]"; \
    fi
USER 65534:65534
ENV PYTHONDONTWRITEBYTECODE=1
ENV LD_LIBRARY_PATH="/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib:/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.12/site-packages/nvidia/cufft/lib:/usr/local/lib/python3.12/site-packages/nvidia/curand/lib:/usr/local/lib/python3.12/site-packages/nvidia/cuda_nvrtc/lib:/usr/local/lib/python3.12/site-packages/nvidia/nvjitlink/lib"
ENTRYPOINT ["python", "-m", "zst_archive.service", "--host", "0.0.0.0"]
