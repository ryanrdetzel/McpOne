/* Thin bounded Mbed TLS 3.6.7 bridge. No cryptography or X.509 interpretation
 * is implemented here. One WASM instance owns exactly one connection.
 * SPDX-License-Identifier: Apache-2.0
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "mbedtls/oid.h"
#include "mbedtls/ssl.h"
#include "mbedtls/platform.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/version.h"
#include "mbedtls/x509_crt.h"

#define IMPORT(name) __attribute__((import_module("mcpone"), import_name(name)))
IMPORT("random") extern int host_random(unsigned char *, unsigned int);
IMPORT("now") extern double host_now(void);
IMPORT("utc") extern int host_utc(double, int *);

#define QUEUE_BYTES 65536u
#define IO_BYTES 16384u
static mbedtls_ssl_context ssl;
static mbedtls_ssl_config config;
static mbedtls_x509_crt roots;
static unsigned char input[QUEUE_BYTES], output[QUEUE_BYTES], io[IO_BYTES];
static size_t input_start, input_length, output_start, output_length;
static int initialized, authenticated, input_closed;
static char expected_hostname[254];
static const char *alpn[] = { "http/1.1", NULL };
static const int suites[] = {
    MBEDTLS_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
    MBEDTLS_TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
    MBEDTLS_TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
    MBEDTLS_TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
    MBEDTLS_TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
    MBEDTLS_TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
    0
};
static const uint16_t signature_algorithms[] = {
    MBEDTLS_TLS1_3_SIG_RSA_PKCS1_SHA256,
    MBEDTLS_TLS1_3_SIG_RSA_PKCS1_SHA384,
    MBEDTLS_TLS1_3_SIG_RSA_PKCS1_SHA512,
    MBEDTLS_TLS1_3_SIG_ECDSA_SECP256R1_SHA256,
    MBEDTLS_TLS1_3_SIG_ECDSA_SECP384R1_SHA384,
    MBEDTLS_TLS1_3_SIG_ECDSA_SECP521R1_SHA512,
    MBEDTLS_TLS1_3_SIG_NONE
};

mbedtls_time_t mcpone_tls_time(mbedtls_time_t *out) {
    mbedtls_time_t value = (mbedtls_time_t) host_now();
    if (out != NULL) *out = value;
    return value;
}
struct tm *mbedtls_platform_gmtime_r(const mbedtls_time_t *value, struct tm *out) {
    int fields[6];
    if (host_utc((double) *value, fields) != 0) return NULL;
    memset(out, 0, sizeof(*out));
    out->tm_year = fields[0] - 1900;
    out->tm_mon = fields[1] - 1;
    out->tm_mday = fields[2];
    out->tm_hour = fields[3];
    out->tm_min = fields[4];
    out->tm_sec = fields[5];
    return out;
}
static int random_bytes(void *ctx, unsigned char *buffer, size_t size) {
    (void) ctx;
    return host_random(buffer, (unsigned int) size) == 0 ? 0 : MBEDTLS_ERR_SSL_INTERNAL_ERROR;
}
static int receive_bytes(void *ctx, unsigned char *buffer, size_t size) {
    (void) ctx;
    if (input_length == 0) return input_closed ? 0 : MBEDTLS_ERR_SSL_WANT_READ;
    if (size > input_length) size = input_length;
    memcpy(buffer, input + input_start, size);
    input_start += size;
    input_length -= size;
    if (input_length == 0) input_start = 0;
    return (int) size;
}
static int send_bytes(void *ctx, const unsigned char *buffer, size_t size) {
    (void) ctx;
    if (size > QUEUE_BYTES - output_length) return MBEDTLS_ERR_SSL_WANT_WRITE;
    if (output_start + output_length + size > QUEUE_BYTES) {
        memmove(output, output + output_start, output_length);
        output_start = 0;
    }
    memcpy(output + output_start + output_length, buffer, size);
    output_length += size;
    return (int) size;
}
static int bounded_verify(void *ctx, mbedtls_x509_crt *cert, int depth, uint32_t *flags) {
    (void) ctx;
    (void) cert;
    /* Never clear upstream chain, hostname, validity, EKU or constraint flags. */
    if (depth >= 10) *flags |= MBEDTLS_X509_BADCERT_OTHER;
    return 0;
}
void tls_destroy(void) {
    if (initialized) {
        mbedtls_ssl_free(&ssl);
        mbedtls_ssl_config_free(&config);
        mbedtls_x509_crt_free(&roots);
    }
    initialized = authenticated = input_closed = 0;
    input_start = input_length = output_start = output_length = 0;
    mbedtls_platform_zeroize(input, sizeof(input));
    mbedtls_platform_zeroize(output, sizeof(output));
    mbedtls_platform_zeroize(io, sizeof(io));
    mbedtls_platform_zeroize(expected_hostname, sizeof(expected_hostname));
}
unsigned int tls_version(void) { return MBEDTLS_VERSION_NUMBER; }
unsigned char *tls_buffer(void) { return io; }
unsigned int tls_buffer_size(void) { return IO_BYTES; }
void *tls_alloc(unsigned int size) { return size <= 524288u ? malloc(size) : NULL; }
void tls_free(void *ptr) { free(ptr); }
int tls_init(const unsigned char *ca, unsigned int size, const char *hostname) {
    int result;
    tls_destroy();
    if (size == 0 || size > 524288u || hostname == NULL || strlen(hostname) > 253u)
        return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    mbedtls_ssl_init(&ssl);
    mbedtls_ssl_config_init(&config);
    mbedtls_x509_crt_init(&roots);
    initialized = 1;
    memcpy(expected_hostname, hostname, strlen(hostname) + 1);
    if ((result = mbedtls_platform_set_time(mcpone_tls_time)) != 0) goto failed;
    /* size includes the PEM terminator; even one rejected root fails closed. */
    if ((result = mbedtls_x509_crt_parse(&roots, ca, size)) != 0) goto failed;
    if ((result = mbedtls_ssl_config_defaults(&config, MBEDTLS_SSL_IS_CLIENT,
        MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT)) != 0) goto failed;
    mbedtls_ssl_conf_authmode(&config, MBEDTLS_SSL_VERIFY_REQUIRED);
    mbedtls_ssl_conf_ca_chain(&config, &roots, NULL);
    mbedtls_ssl_conf_verify(&config, bounded_verify, NULL);
    mbedtls_ssl_conf_rng(&config, random_bytes, NULL);
    mbedtls_ssl_conf_ciphersuites(&config, suites);
    mbedtls_ssl_conf_sig_algs(&config, signature_algorithms);
    mbedtls_ssl_conf_cert_profile(&config, &mbedtls_x509_crt_profile_default);
    mbedtls_ssl_conf_min_tls_version(&config, MBEDTLS_SSL_VERSION_TLS1_2);
    mbedtls_ssl_conf_max_tls_version(&config, MBEDTLS_SSL_VERSION_TLS1_2);
    if ((result = mbedtls_ssl_conf_alpn_protocols(&config, alpn)) != 0) goto failed;
    if ((result = mbedtls_ssl_setup(&ssl, &config)) != 0) goto failed;
    /* Upstream uses SAN in preference to CN, leftmost-label wildcards only. */
    if ((result = mbedtls_ssl_set_hostname(&ssl, hostname)) != 0) goto failed;
    mbedtls_ssl_set_bio(&ssl, NULL, send_bytes, receive_bytes, NULL);
    return 0;
failed:
    tls_destroy();
    return result == 0 ? MBEDTLS_ERR_SSL_INTERNAL_ERROR : result;
}
int tls_feed(unsigned int size) {
    if (!initialized || size > IO_BYTES || size > QUEUE_BYTES - input_length)
        return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    if (input_start + input_length + size > QUEUE_BYTES) {
        memmove(input, input + input_start, input_length);
        input_start = 0;
    }
    memcpy(input + input_start + input_length, io, size);
    input_length += size;
    return (int) size;
}
void tls_eof(void) { input_closed = 1; }
int tls_drain(void) {
    size_t size = output_length > IO_BYTES ? IO_BYTES : output_length;
    memcpy(io, output + output_start, size);
    output_start += size;
    output_length -= size;
    if (output_length == 0) output_start = 0;
    return (int) size;
}
/* Mbed TLS's general X.509 name verifier also understands URI identities.
 * HTTPS needs DNS-ID (or IP-ID), not a malformed URI-ID equal to a hostname.
 * On mixed-type SANs, give the SAME upstream verifier a shallow read-only leaf
 * with only the applicable SAN type. No wildcard/signature/chain logic here.
 * Original cert/chain and its successful verification flags remain untouched.
 */
static int verify_https_identity(const mbedtls_x509_crt *peer) {
    uint32_t address[4], flags = 0;
    unsigned int kind = mbedtls_x509_crt_parse_cn_inet_pton(expected_hostname, address)
        ? MBEDTLS_X509_SAN_IP_ADDRESS : MBEDTLS_X509_SAN_DNS_NAME;
    size_t count = 0;
    int needs_filter = 0;
    if (!(peer->MBEDTLS_PRIVATE(ext_types) & MBEDTLS_X509_EXT_SUBJECT_ALT_NAME))
        return kind == MBEDTLS_X509_SAN_IP_ADDRESS ? MBEDTLS_ERR_X509_CERT_VERIFY_FAILED : 0;
    for (const mbedtls_x509_sequence *node = &peer->subject_alt_names; node != NULL; node = node->next) {
        unsigned int type = (unsigned int) node->buf.tag & MBEDTLS_ASN1_TAG_VALUE_MASK;
        if (type == kind) count++;
        if (type == MBEDTLS_X509_SAN_UNIFORM_RESOURCE_IDENTIFIER ||
            (kind == MBEDTLS_X509_SAN_IP_ADDRESS && type == MBEDTLS_X509_SAN_DNS_NAME))
            needs_filter = 1;
    }
    if (!needs_filter) return 0;
    if (count == 0) return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    mbedtls_x509_sequence *names = calloc(count, sizeof(*names));
    if (names == NULL) return MBEDTLS_ERR_X509_ALLOC_FAILED;
    size_t index = 0;
    for (const mbedtls_x509_sequence *node = &peer->subject_alt_names; node != NULL; node = node->next) {
        if (((unsigned int) node->buf.tag & MBEDTLS_ASN1_TAG_VALUE_MASK) == kind) {
            names[index].buf = node->buf;
            if (index + 1 < count) names[index].next = &names[index + 1];
            index++;
        }
    }
    mbedtls_x509_crt leaf = *peer;
    leaf.subject_alt_names = names[0];
    int result = mbedtls_x509_crt_verify_with_profile(&leaf, &roots, NULL,
        &mbedtls_x509_crt_profile_default, expected_hostname, &flags, NULL, NULL);
    free(names);
    return result == 0 && flags == 0 ? 0 : MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
}
int tls_handshake(void) {
    int result;
    if (!initialized) return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    result = mbedtls_ssl_handshake(&ssl);
    if (result == 0) {
        if (mbedtls_ssl_get_verify_result(&ssl) != 0 || mbedtls_ssl_get_peer_cert(&ssl) == NULL)
            return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
        const mbedtls_x509_crt *cert = mbedtls_ssl_get_peer_cert(&ssl);
        unsigned int count = 0;
        while (cert != NULL) {
            if (++count > 10) return MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
            cert = cert->next;
        }
        if ((result = verify_https_identity(mbedtls_ssl_get_peer_cert(&ssl))) != 0) return result;
        authenticated = 1;
    }
    return result;
}
int tls_read(void) {
    if (!authenticated) return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    int result = mbedtls_ssl_read(&ssl, io, IO_BYTES);
    /* Only close_notify is an authenticated EOF. Bare TCP EOF is truncation. */
    if (result == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY) return 0;
    return result == 0 ? MBEDTLS_ERR_SSL_CONN_EOF : result;
}
int tls_write(unsigned int size) {
    if (!authenticated || size > IO_BYTES) return MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
    return mbedtls_ssl_write(&ssl, io, size);
}
int tls_close_notify(void) {
    return authenticated ? mbedtls_ssl_close_notify(&ssl) : MBEDTLS_ERR_SSL_BAD_INPUT_DATA;
}
