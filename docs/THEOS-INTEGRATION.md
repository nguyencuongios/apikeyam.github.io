# Theos / Objective-C integration

The following is a minimal NSURLSession example. Replace the endpoint with the
deployed HTTPS function URL. Do not hardcode administrator credentials in a tweak.

```objc
// APIClient.h
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
@interface AGAPIClient : NSObject
@property (nonatomic, copy) NSString *baseURL;
- (void)validateKey:(NSString *)key
         packageID:(NSString *)packageID
           tweakID:(NSString *)tweakID
 deviceFingerprint:(NSString *)fingerprint
        completion:(void (^)(NSDictionary * _Nullable result, NSError * _Nullable error))completion;
@end
NS_ASSUME_NONNULL_END
```

```objc
// APIClient.m
#import "APIClient.h"

@implementation AGAPIClient
- (instancetype)init {
    self = [super init];
    if (self) _baseURL = @"https://YOUR_DEPLOYED_FUNCTION_URL";
    return self;
}
- (void)validateKey:(NSString *)key
         packageID:(NSString *)packageID
           tweakID:(NSString *)tweakID
 deviceFingerprint:(NSString *)fingerprint
        completion:(void (^)(NSDictionary *, NSError *))completion {
    NSURL *url = [NSURL URLWithString:[self.baseURL stringByAppendingString:@"/api/v1/license/validate"]];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url
                                                           cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                       timeoutInterval:15.0];
    request.HTTPMethod = @"POST";
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    NSDictionary *body = @{
        @"licenseKey": key,
        @"packageId": packageID,
        @"tweakId": tweakID,
        @"deviceFingerprint": fingerprint
    };
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [[[NSURLSession sharedSession] dataTaskWithRequest:request
                                     completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) { dispatch_async(dispatch_get_main_queue(), ^{ completion(nil, error); }); return; }
        NSError *jsonError = nil;
        NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&jsonError];
        dispatch_async(dispatch_get_main_queue(), ^{ completion(json, jsonError); });
    }] resume];
}
@end
```

## Production hardening required
A device fingerprint supplied by an untrusted client is not proof of device identity.
Add request timestamp, nonce replay protection, signed payloads, per-tweak
credentials, and server-side atomic transactions before production rollout.
Do not treat a secret compiled into an iOS tweak as confidential.
