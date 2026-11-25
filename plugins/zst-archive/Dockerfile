FROM python:3.12-slim
WORKDIR /opt/r4
COPY pyproject.toml ./
COPY zst_archive ./zst_archive
RUN pip install --no-cache-dir .
USER 65534:65534
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python", "-m", "zst_archive.service", "--host", "0.0.0.0"]
