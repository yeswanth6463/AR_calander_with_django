
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    ProjectViewSet,
    TargetImageViewSet,
    ModelAssetViewSet,
    ARExperienceViewSet,
    ExperienceItemViewSet,
    compile_targets,
    register_target,
    track_image,
    target_features,
)
from .views_auth import (
    CSRFView,
    login_view,
    logout_view,
    me,
    public_experience,
    publish_experience,
    publish_project,
    register,
    unpublish_experience,
)

router = DefaultRouter()
router.register("projects", ProjectViewSet, basename="project")
router.register("targets", TargetImageViewSet, basename="target")
router.register("assets", ModelAssetViewSet, basename="asset")
router.register("experiences", ARExperienceViewSet, basename="experience")
router.register("items", ExperienceItemViewSet, basename="experience-item")

urlpatterns = [
    path(
        "projects/<uuid:project_id>/publish/",
        publish_project,
        name="project-publish",
    ),
    path(
        "projects/<uuid:project_id>/compile-targets/",
        compile_targets,
        name="project-compile-targets",
    ),
    path("", include(router.urls)),
    path(
        "targets/<uuid:target_id>/register/",
        register_target,
        name="register-target",
    ),
    path(
        "targets/<uuid:target_id>/features/",
        target_features,
        name="target-features",
    ),
    path(
        "targets/<uuid:target_id>/track/",
        track_image,
        name="track-image",
    ),
    path("auth/csrf/", CSRFView.as_view(), name="auth-csrf"),
    path("auth/register/", register, name="auth-register"),
    path("auth/login/", login_view, name="auth-login"),
    path("auth/logout/", logout_view, name="auth-logout"),
    path("auth/me/", me, name="auth-me"),
    path(
        "experiences/<uuid:experience_id>/publish/",
        publish_experience,
        name="experience-publish",
    ),
    path(
        "experiences/<uuid:experience_id>/unpublish/",
        unpublish_experience,
        name="experience-unpublish",
    ),
    path(
        "public/<str:public_id>/",
        public_experience,
        name="public-experience",
    ),
]
