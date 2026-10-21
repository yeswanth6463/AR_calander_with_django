#!/bin/sh
set -e

echo "Waiting for database..."
python - <<'PY'
import os
import sys
import time

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "AR_cal.settings")
django.setup()

from django.db import connections  # noqa: E402

for attempt in range(30):
    try:
        connections["default"].ensure_connection()
        print("Database is ready.", flush=True)
        break
    except Exception as exc:
        print(f"Database not ready ({exc}); retry {attempt + 1}/30", flush=True)
        time.sleep(2)
else:
    sys.exit("Could not connect to the database.")

PY

python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec gunicorn AR_cal.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers "${GUNICORN_WORKERS:-3}" \
    --timeout 120 \
    --access-logfile - \
    --error-logfile -
