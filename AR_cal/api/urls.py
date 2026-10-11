
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    ProjectViewSet,
    TargetImageViewSet,
    ModelAssetViewSet,
    ARExperienceViewSet,
    register_target,
    track_image,
)

router = DefaultRouter()
router.register("projects", ProjectViewSet, basename="project")
router.register("targets", TargetImageViewSet, basename="target")
router.register("assets", ModelAssetViewSet, basename="asset")
router.register("experiences",ARExperienceViewSet,basename="experience",)

urlpatterns = [
    path("", include(router.urls)),
    path(
        "targets/<uuid:target_id>/register/",
        register_target,
        name="register-target",
    ),
    path(
        "targets/<uuid:target_id>/track/",
        track_image,
        name="track-image",
    ),
]
