from django.conf import settings
from django.db import models
from django.contrib.auth.models import AbstractUser
from django.utils.text import slugify
import uuid

from .anchors import ANCHOR_TYPES, PROJECT_TYPES

class User(AbstractUser):
    ROLE_CHOICES = [
        ("super_admin", "Super Admin"),
        ("finance_admin", "Finance Admin"),
        ("content_admin", "Content Admin"),
        ("support_admin", "Support Admin"),
        ("customer", "Customer"),
    ]
    CUSTOMER_TYPE_CHOICES = [
        ("individual", "Individual Customer"),
        ("enterprise", "Enterprise Member"),
    ]

    email = models.EmailField(unique=True)
    phone_number = models.CharField(
        max_length=20,
        blank=True,
        null=True,
    )
    profile_image = models.ImageField(
        upload_to="profile_images/",
        blank=True,
        null=True,
    )
    role = models.CharField(
        max_length=20,
        choices=ROLE_CHOICES,
        default="customer",
        help_text="Administrative or customer role for platform access control.",
    )
    customer_type = models.CharField(
        max_length=20,
        choices=CUSTOMER_TYPE_CHOICES,
        default="individual",
        help_text="Customer account tier type.",
    )
    storage_used_bytes = models.BigIntegerField(
        default=0,
        help_text="Total storage consumed by user assets in bytes.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.email} ({self.role})"


class Organization(models.Model):
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    name = models.CharField(max_length=150)
    slug = models.SlugField(max_length=180, unique=True, blank=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="owned_organizations",
        help_text="Organization administrator / creator.",
    )
    is_active = models.BooleanField(default=True)
    storage_limit_bytes = models.BigIntegerField(
        default=21474836480,  # 20 GB default enterprise quota
        help_text="Maximum storage allocation for organization in bytes.",
    )
    storage_used_bytes = models.BigIntegerField(
        default=0,
        help_text="Current total storage used by organization assets.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        if not self.slug:
            base_slug = slugify(self.name) or "org"
            candidate = base_slug
            counter = 2
            while Organization.objects.filter(slug=candidate).exists():
                candidate = f"{base_slug}-{counter}"
                counter += 1
            self.slug = candidate
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class OrganizationMember(models.Model):
    MEMBER_ROLE_CHOICES = [
        ("org_admin", "Organization Admin"),
        ("editor", "Editor"),
        ("viewer", "Viewer"),
    ]

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="members",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="organization_memberships",
    )
    role = models.CharField(
        max_length=20,
        choices=MEMBER_ROLE_CHOICES,
        default="editor",
    )
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("organization", "user")
        ordering = ["joined_at"]

    def __str__(self):
        return f"{self.user.email} - {self.organization.name} ({self.role})"

class Project(models.Model):
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="ar_projects",
    )
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="projects",
        null=True,
        blank=True,
        help_text="Owning enterprise workspace if created under an organization.",
    )
    name = models.CharField(max_length=150)
    slug = models.SlugField(max_length=180, unique=True, blank=True)
    description = models.TextField(blank=True)
    project_type = models.CharField(
        max_length=20,
        choices=PROJECT_TYPES,
        default="image_ar",
        help_text="Chosen in the new-project wizard; fixed after creation.",
    )
    type_settings = models.JSONField(
        blank=True,
        null=True,
        help_text="Viewer options for face / object projects (from the wizard).",
    )
    game_logic = models.JSONField(
        blank=True,
        null=True,
        help_text="AR Game rule builder rules, variables and optional script.",
    )
    game_settings = models.JSONField(
        blank=True,
        null=True,
        help_text=(
            "AR game rules for the published link: goal (none/score/collect_all), "
            "target_score, time_limit (s), intro/win/lose messages."
        ),
    )
    # Compiled image-target bundle (MindAR ".mind" equivalent), built on the
    # server by api/service/target_bundle.py and loaded by the AR viewer.
    compiled_targets = models.FileField(
        upload_to="compiled_targets/",
        blank=True,
        max_length=255,
    )
    targets_signature = models.CharField(
        max_length=40,
        blank=True,
        default="",
        help_text="Signature of the target set the bundle was compiled from.",
    )
    targets_compiled_at = models.DateTimeField(blank=True, null=True)
    is_active = models.BooleanField(default=True)
    is_shared = models.BooleanField(
        default=False,
        help_text="Whether this asset has been published to the shared marketplace.",
    )
    approval_status = models.CharField(
        max_length=20,
        choices=[
            ("private", "Private Asset"),
            ("pending", "Pending Admin Approval"),
            ("approved", "Approved for Shared Marketplace"),
            ("rejected", "Rejected by Admin"),
        ],
        default="private",
    )
    file_size_bytes = models.BigIntegerField(
        default=0,
        help_text="File size in bytes for storage tracking.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        if not self.slug:
            base_slug = slugify(self.name) or "project"
            candidate = base_slug
            counter = 2

            while Project.objects.filter(slug=candidate).exists():
                candidate = f"{base_slug}-{counter}"
                counter += 1

            self.slug = candidate

        super().save(*args, **kwargs)

    def __str__(self):
        return self.name

class TargetImage(models.Model):
    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="target_images",
    )
    name = models.CharField(max_length=150)
    image = models.ImageField(upload_to="target_images/")
    target_width = models.FloatField(
        default=0.2,
        help_text="Physical target width in metres.",
    )
    is_active = models.BooleanField(default=True)

    # Cached image-feature metadata; generated by our service.
    tracking_data = models.JSONField(blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.name

class ModelAsset(models.Model):
    FORMAT_CHOICES = [
        ("glb", "GLB"),
        ("gltf", "GLTF"),
        ("mp4", "MP4 video"),
        ("webm", "WebM video"),
        ("gif", "GIF"),
        ("png", "PNG image"),
        ("jpg", "JPG image"),
        ("jpeg", "JPEG image"),
        ("webp", "WebP image"),
        ("mp3", "MP3 sound"),
        ("wav", "WAV sound"),
        ("ogg", "OGG sound"),
    ]

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="model_assets",
    )
    name = models.CharField(max_length=150)
    model_file = models.FileField(upload_to="models/")
    format = models.CharField(max_length=10, choices=FORMAT_CHOICES)
    optimized = models.BooleanField(
        default=False,
        help_text="Set when the studio ran the AR model optimiser before upload.",
    )
    is_active = models.BooleanField(default=True)
    is_shared = models.BooleanField(
        default=False,
        help_text="Whether this asset has been published to the shared marketplace.",
    )
    approval_status = models.CharField(
        max_length=20,
        choices=[
            ("private", "Private Asset"),
            ("pending", "Pending Admin Approval"),
            ("approved", "Approved for Shared Marketplace"),
            ("rejected", "Rejected by Admin"),
        ],
        default="private",
    )
    file_size_bytes = models.BigIntegerField(
        default=0,
        help_text="File size in bytes for storage tracking.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

class ARExperience(models.Model):
    STATUS_CHOICES = [
        ("draft", "Draft"),
        ("published", "Published"),
    ]

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    project = models.ForeignKey(
        Project,
        on_delete=models.CASCADE,
        related_name="experiences",
    )
    name = models.CharField(max_length=150, blank=True, default="")
    # Legacy single-pair fields — kept so already-published links keep working.
    # New scenes use `items` (many targets × many models) instead.
    target_image = models.ForeignKey(
        TargetImage,
        on_delete=models.PROTECT,
        related_name="experiences",
        null=True,
        blank=True,
    )
    model_asset = models.ForeignKey(
        ModelAsset,
        on_delete=models.PROTECT,
        related_name="experiences",
        null=True,
        blank=True,
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default="draft",
    )
    position_x = models.FloatField(default=0.0)
    position_y = models.FloatField(default=0.0)
    position_z = models.FloatField(default=0.0)
    rotation_x = models.FloatField(default=0.0)
    rotation_y = models.FloatField(default=0.0)
    rotation_z = models.FloatField(default=0.0)
    scale = models.FloatField(default=1.0)
    scale_x = models.FloatField(default=1.0)
    scale_y = models.FloatField(default=1.0)
    scale_z = models.FloatField(default=1.0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def clean(self):
        from django.core.exceptions import ValidationError

        if self.target_image_id and self.project_id:
            if self.target_image.project_id != self.project_id:
                raise ValidationError(
                    "Target image must belong to the same project."
                )

        if self.model_asset_id and self.project_id:
            if self.model_asset.project_id != self.project_id:
                raise ValidationError(
                    "3D model must belong to the same project."
                )

        if min(self.scale_x, self.scale_y, self.scale_z) <= 0:
            raise ValidationError("Scale values must be greater than zero.")

    def __str__(self):
        return f"AR Experience - {self.project.name}"

class ExperienceItem(models.Model):
    """One (target image + model + transform) placement inside an experience.

    An experience can hold many items: several markers, each carrying one or
    more models, all served through the same published link.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    experience = models.ForeignKey(
        ARExperience,
        on_delete=models.CASCADE,
        related_name="items",
    )
    target_image = models.ForeignKey(
        TargetImage,
        on_delete=models.PROTECT,
        related_name="experience_items",
        null=True,
        blank=True,
        help_text="Required for image anchors; empty for face / object anchors.",
    )
    anchor_type = models.CharField(max_length=10, choices=ANCHOR_TYPES, default="image")
    anchor_value = models.CharField(
        max_length=80,
        blank=True,
        default="",
        help_text="Face point (e.g. eyes) or object label (e.g. cup).",
    )
    model_asset = models.ForeignKey(
        ModelAsset,
        on_delete=models.PROTECT,
        related_name="experience_items",
    )
    name = models.CharField(max_length=150, blank=True, default="")
    order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    position_x = models.FloatField(default=0.0)
    position_y = models.FloatField(default=0.0)
    position_z = models.FloatField(default=0.0)
    rotation_x = models.FloatField(default=0.0)
    rotation_y = models.FloatField(default=0.0)
    rotation_z = models.FloatField(default=0.0)
    scale = models.FloatField(default=1.0)
    scale_x = models.FloatField(default=1.0)
    scale_y = models.FloatField(default=1.0)
    scale_z = models.FloatField(default=1.0)
    animation = models.JSONField(
        blank=True,
        null=True,
        help_text="Playback settings: clips, loop, speed, autoplay.",
    )
    behaviors = models.JSONField(
        blank=True,
        null=True,
        help_text=(
            "Interaction rules for the AR viewer: "
            '{"start_hidden": bool, "on_tap": [{"action": str, "value": any}]}.'
        ),
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "created_at"]

    def clean(self):
        from django.core.exceptions import ValidationError

        if self.target_image_id and self.experience_id:
            if self.target_image.project_id != self.experience.project_id:
                raise ValidationError(
                    "Target image must belong to the same project."
                )

        if self.model_asset_id and self.experience_id:
            if self.model_asset.project_id != self.experience.project_id:
                raise ValidationError(
                    "3D model must belong to the same project."
                )

        if min(self.scale_x, self.scale_y, self.scale_z) <= 0:
            raise ValidationError("Scale values must be greater than zero.")

    def __str__(self):
        return f"Item {self.name or self.id} ({self.experience_id})"

class ProjectPublication(models.Model):
    """One public link for a chosen set of scenes in a project.

    Scene rows stay on ARExperience. This record only stores their ids and a
    frozen snapshot so the share URL keeps working after later edits.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.OneToOneField(
        Project,
        on_delete=models.CASCADE,
        related_name="publication",
    )
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    slug = models.SlugField(max_length=80, unique=True, null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    is_active = models.BooleanField(default=True)
    scene_ids = models.JSONField(default=list, blank=True)
    scene_snapshot = models.JSONField(blank=True, null=True)
    published_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Publication - {self.project.name}"


class PublishedExperience(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    experience = models.OneToOneField(
        ARExperience,
        on_delete=models.CASCADE,
        related_name="published_experience",
    )

    public_id = models.UUIDField(
        default=uuid.uuid4,
        unique=True,
        editable=False,
    )

    slug = models.SlugField(
        max_length=80,
        unique=True,
        null=True,
        blank=True,
        help_text="Custom name for the public viewer link.",
    )

    version = models.PositiveIntegerField(default=1)

    is_active = models.BooleanField(default=True)

    scene_snapshot = models.JSONField(
        blank=True,
        null=True,
        help_text="Frozen public scene (items, transforms, assets) captured at publish time.",
    )

    published_at = models.DateTimeField(auto_now_add=True)

    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Published - {self.experience.project.name}"

class QRCode(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    published_experience = models.OneToOneField(
        PublishedExperience,
        on_delete=models.CASCADE,
        related_name="qr_code",
    )

    qr_image = models.ImageField(
        upload_to="qr_codes/",
        blank=True,
        null=True,
    )

    public_url = models.URLField(max_length=500)

    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"QR - {self.published_experience.experience.project.name}"