from django.contrib import admin

from .models import (
    User,
    Project,
    TargetImage,
    ModelAsset,
    ARExperience,
    PublishedExperience,
    QRCode,
)


admin.site.register(User)
admin.site.register(Project)
admin.site.register(TargetImage)
admin.site.register(ModelAsset)
admin.site.register(ARExperience)
admin.site.register(PublishedExperience)
admin.site.register(QRCode)