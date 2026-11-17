"""
Django settings for AR_cal project.

All deployment-sensitive values are read from environment variables
(see .env.example) via python-decouple.
"""

from pathlib import Path

from decouple import Csv, config

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# SECURITY WARNING: keep the secret key used in production secret!
# No default on purpose: a missing SECRET_KEY must fail loudly, never fall back
# to a value that is committed to git.
SECRET_KEY = config("SECRET_KEY")

# SECURITY WARNING: don't run with debug turned on in production!
# Opt in with DEBUG=True in a local .env.
DEBUG = config("DEBUG", default=False, cast=bool)

ALLOWED_HOSTS = config("ALLOWED_HOSTS", default="localhost,127.0.0.1", cast=Csv())

# Vite often jumps from 5173 to 5174+ when a port is busy. Always trust local
# studio origins so DELETE/PATCH are not blocked by CSRF origin checks.
_CSRF_FROM_ENV = [
    origin
    for origin in (
        config(
            "CSRF_TRUSTED_ORIGINS",
            default="",
            cast=Csv(),
        )
        or []
    )
    if origin
]
_CSRF_LOCAL = []
for _port in list(range(5170, 5191)) + [3000, 4173, 8000, 8080]:
    _CSRF_LOCAL.extend(
        [
            f"http://localhost:{_port}",
            f"http://127.0.0.1:{_port}",
            f"https://localhost:{_port}",
            f"https://127.0.0.1:{_port}",
        ]
    )
CSRF_TRUSTED_ORIGINS = list(dict.fromkeys(_CSRF_FROM_ENV + _CSRF_LOCAL))

# Application definition

INSTALLED_APPS = [
    "jazzmin",
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    "drf_spectacular",
    'api'
]

AUTH_USER_MODEL = "api.User"

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'AR_cal.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'AR_cal.wsgi.application'

# Database
# https://docs.djangoproject.com/en/6.1/ref/settings/#databases

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": config("POSTGRES_DB", default=""),
        "USER": config("POSTGRES_USER", default="postgres"),
        "PASSWORD": config("POSTGRES_PASSWORD"),
        "HOST": config("POSTGRES_HOST", default="localhost"),
        "PORT": config("POSTGRES_PORT", default="5433"),
        "CONN_MAX_AGE": 60,
    }
}

# Password validation
# https://docs.djangoproject.com/en/6.1/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

# Internationalization
# https://docs.djangoproject.com/en/6.1/topics/i18n/

LANGUAGE_CODE = 'en-us'

TIME_ZONE = 'UTC'

USE_I18N = True

USE_TZ = True

# Static files (CSS, JavaScript, Images)
# https://docs.djangoproject.com/en/6.1/howto/static-files/

STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / "staticfiles"

MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# Security / proxy hardening (terminate TLS at nginx in front of the app)
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
if not DEBUG:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = "DENY"

# Email
# https://docs.djangoproject.com/en/6.1/topics/email/#topic-email-configuration
# Set EMAIL_BACKEND (and related SMTP vars) in production; console by default.

MAILERS = {
    'default': {
        'BACKEND': config(
            "EMAIL_BACKEND",
            default="django.core.mail.backends.console.EmailBackend",
        ),
    },
}

REST_FRAMEWORK = {
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    # Per-IP limits for the anonymous auth endpoints (see api/views_auth.py).
    # The default LocMemCache is per-process, so with N gunicorn workers the
    # effective limit is up to N x the rate; use a shared cache for a strict one.
    "DEFAULT_THROTTLE_RATES": {
        "login": config("LOGIN_THROTTLE_RATE", default="10/min"),
        "register": config("REGISTER_THROTTLE_RATE", default="5/hour"),
    },
}

SPECTACULAR_SETTINGS = {
    "TITLE": "AR Studio API",
    "DESCRIPTION": (
        "API documentation for AR Studio, including projects, "
        "target image registration, computer-vision tracking, "
        "3D model assets, and AR experiences."
    ),
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}
