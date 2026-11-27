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
      pip install --no-cache-dir $INDEX_FLAG ".[analytics,balanced]"; \
    elif [ "$INSTALL_ANALYTICS" = "true" ]; then \
      pip install --no-cache-dir $INDEX_FLAG ".[analytics]"; \
    else \
      pip install --no-cache-dir $INDEX_FLAG .; \
    fi
USER 65534:65534
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python", "-m", "zst_archive.service", "--host", "0.0.0.0"]
