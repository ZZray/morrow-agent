"""S3-compatible business Host using the official boto3 client. Author: Ray Zhang."""
import os
from pathlib import Path
import uuid
from common import Host, cli, service_endpoint


class ObjectStoreHost(Host):
    kind = 'object-store'

    @staticmethod
    def target(root: Path) -> dict:
        prefix = os.environ['MORROW_HOST_S3_PREFIX'].strip('/')
        if not prefix:
            raise ValueError('an explicit nonempty object prefix is required')
        return {'endpoint': service_endpoint(os.environ['MORROW_HOST_S3_ENDPOINT']),
                'region': os.environ.get('AWS_DEFAULT_REGION', 'us-east-1'),
                'bucket': os.environ['MORROW_HOST_S3_BUCKET'],
                'key': f'{prefix}/{uuid.uuid4().hex}/result.txt'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        import boto3
        from botocore.config import Config
        target = self.manifest['target']
        self.s3 = boto3.client('s3', endpoint_url=target['endpoint'], region_name=target['region'],
            aws_access_key_id=os.environ['AWS_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['AWS_SECRET_ACCESS_KEY'],
            aws_session_token=os.environ.get('AWS_SESSION_TOKEN'),
            config=Config(signature_version='s3v4', retries={'total_max_attempts': 1},
                          connect_timeout=3, read_timeout=4, s3={'addressing_style': 'path'}))

    def write_payload(self, content: bytes) -> dict:
        target = self.manifest['target']
        response = self.s3.put_object(Bucket=target['bucket'], Key=target['key'], Body=content,
                                      ContentType='text/plain; charset=utf-8')
        return {'bucket': target['bucket'], 'key': target['key'], 'etag': response.get('ETag'),
                'version_id': response.get('VersionId'),
                'request_id': response['ResponseMetadata'].get('RequestId')}

    def read_payload(self) -> bytes:
        target = self.manifest['target']
        response = self.s3.get_object(Bucket=target['bucket'], Key=target['key'])
        with response['Body'] as stream:
            content = stream.read(64 * 1024 + 1)
        if len(content) > 64 * 1024:
            raise ValueError('object exceeds Host payload limit')
        return content


if __name__ == '__main__':
    cli(ObjectStoreHost)
