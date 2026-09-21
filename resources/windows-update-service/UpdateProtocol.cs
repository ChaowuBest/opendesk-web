/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

using System;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenDesk.UpdateService
{
    [DataContract]
    internal sealed class UpdateRequest
    {
        [DataMember(Name = "protocolVersion")]
        public int ProtocolVersion { get; set; }

        [DataMember(Name = "requestId")]
        public string RequestId { get; set; }

        [DataMember(Name = "action")]
        public string Action { get; set; }

        [DataMember(Name = "targetVersion", EmitDefaultValue = false)]
        public string TargetVersion { get; set; }

        [DataMember(Name = "sourcePath", EmitDefaultValue = false)]
        public string SourcePath { get; set; }

        [DataMember(Name = "sha256", EmitDefaultValue = false)]
        public string Sha256 { get; set; }

        [DataMember(Name = "processId", EmitDefaultValue = false)]
        public int ProcessId { get; set; }
    }

    [DataContract]
    internal sealed class UpdateResponse
    {
        [DataMember(Name = "protocolVersion")]
        public int ProtocolVersion { get; set; }

        [DataMember(Name = "requestId")]
        public string RequestId { get; set; }

        [DataMember(Name = "status")]
        public string Status { get; set; }

        [DataMember(Name = "code")]
        public string Code { get; set; }

        [DataMember(Name = "targetVersion", EmitDefaultValue = false)]
        public string TargetVersion { get; set; }

        [DataMember(Name = "installerExitCode", EmitDefaultValue = false)]
        public int? InstallerExitCode { get; set; }

        [DataMember(Name = "cleanupExitCode", EmitDefaultValue = false)]
        public int? CleanupExitCode { get; set; }

        [DataMember(Name = "message", EmitDefaultValue = false)]
        public string Message { get; set; }

        [DataMember(Name = "updatedAtUtc")]
        public string UpdatedAtUtc { get; set; }

        public static UpdateResponse Create(string requestId, string status, string code)
        {
            return new UpdateResponse
            {
                ProtocolVersion = 1,
                RequestId = requestId ?? string.Empty,
                Status = status,
                Code = code,
                UpdatedAtUtc = DateTime.UtcNow.ToString("o")
            };
        }
    }

    internal static class UpdateProtocol
    {
        public const int Version = 1;
        public const int MaximumMessageCharacters = 16384;
        public const string QueryStatus = "queryStatus";
        public const string SubmitUpdate = "submitUpdate";
        public const string ReportHealthy = "reportHealthy";
        private static readonly Regex StableVersion = new Regex(@"^\d+\.\d+\.\d+$", RegexOptions.CultureInvariant);
        private static readonly Regex Sha256 = new Regex(@"^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant);

        public static string Validate(UpdateRequest request)
        {
            if (request == null) return "invalid_json";
            if (request.ProtocolVersion != Version) return "unsupported_protocol";
            Guid requestId;
            if (!Guid.TryParse(request.RequestId, out requestId) || requestId == Guid.Empty) return "invalid_request_id";
            if (request.Action != QueryStatus && request.Action != SubmitUpdate && request.Action != ReportHealthy)
            {
                return "unsupported_action";
            }

            if (request.Action == QueryStatus) return null;
            if (string.IsNullOrWhiteSpace(request.TargetVersion) || !StableVersion.IsMatch(request.TargetVersion))
            {
                return "invalid_target_version";
            }

            if (request.Action == ReportHealthy)
            {
                return request.ProcessId > 0 ? null : "invalid_process_id";
            }

            if (string.IsNullOrWhiteSpace(request.SourcePath) || request.SourcePath.Length > 4096)
            {
                return "invalid_source_path";
            }
            if (!request.SourcePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return "invalid_source_path";
            if (string.IsNullOrWhiteSpace(request.Sha256) || !Sha256.IsMatch(request.Sha256)) return "invalid_sha256";
            return null;
        }

        public static UpdateRequest Deserialize(string json)
        {
            if (string.IsNullOrWhiteSpace(json) || json.Length > MaximumMessageCharacters) return null;
            try
            {
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(UpdateRequest));
                using (MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                {
                    return serializer.ReadObject(stream) as UpdateRequest;
                }
            }
            catch
            {
                return null;
            }
        }

        public static string Serialize(UpdateResponse response)
        {
            DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(UpdateResponse));
            using (MemoryStream stream = new MemoryStream())
            {
                serializer.WriteObject(stream, response);
                return Encoding.UTF8.GetString(stream.ToArray());
            }
        }
    }
}
